const DEFAULTS = Object.freeze({
  mergeTolerance: 1,
  endpointTolerance: undefined,
  maxGapDistance: 40,
  gapConnectorsPerNode: 2,
  gapFixedCost: 4,
  gapCostFactor: 1.35,
  gapSpeed: 1.4,
  projectionMinGain: 2,
  segmentSampleStep: 64,
  respectOneWay: true,
  maxFallbackBridges: 0,
  maxFallbackBridgeDistance: Infinity,
});
const MAX_SAMPLES_PER_SEGMENT = 1_000_000;
const GEOMETRY_EPSILON = 1e-9;
const OPTION_NAMES = new Set(Object.keys(DEFAULTS));
const ROUTE_OPTION_NAMES = new Set([
  "anchorCandidateCount",
  "maxFallbackBridgeDistance",
  "maxFallbackBridges",
  "maxSnapDistance",
]);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const coordinateDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const isNodeId = (value) => (
  typeof value === "string"
  || (typeof value === "number" && Number.isFinite(value))
);

const finitePoint = (point, label) => {
  if (
    typeof point !== "object"
    || point === null
    || !Number.isFinite(point.x)
    || !Number.isFinite(point.y)
  ) {
    throw new TypeError(`${label} must have finite numeric x and y coordinates`);
  }
  return { x: point.x, y: point.y };
};

const compareIds = (a, b) => {
  const aType = typeof a;
  const bType = typeof b;
  if (aType !== bType) return aType === "number" ? -1 : 1;
  if (aType === "number") return a - b;
  return a < b ? -1 : a > b ? 1 : 0;
};

const validateCoordinates = (coordinates, label) => {
  if (!Array.isArray(coordinates)) {
    throw new TypeError(`${label} must be an array of finite numeric pairs`);
  }
  for (const coordinate of coordinates) {
    if (
      !Array.isArray(coordinate)
      || coordinate.length < 2
      || !Number.isFinite(coordinate[0])
      || !Number.isFinite(coordinate[1])
    ) {
      throw new TypeError(`${label} must contain finite numeric pairs`);
    }
  }
};

const normalizeOptions = (overrides) => {
  if (
    typeof overrides !== "object"
    || overrides === null
    || Array.isArray(overrides)
  ) {
    throw new TypeError("options must be an object");
  }
  const options = { ...DEFAULTS };
  for (const [name, value] of Object.entries(overrides)) {
    if (!OPTION_NAMES.has(name)) {
      throw new TypeError(`unknown router option: ${name}`);
    }
    if (value !== undefined) options[name] = value;
  }
  if (options.endpointTolerance === undefined) {
    options.endpointTolerance = options.mergeTolerance;
  }

  for (const name of [
    "mergeTolerance",
    "endpointTolerance",
    "maxGapDistance",
    "gapFixedCost",
    "gapCostFactor",
    "projectionMinGain",
  ]) {
    if (!Number.isFinite(options[name]) || options[name] < 0) {
      throw new TypeError(`${name} must be a finite non-negative number`);
    }
  }
  for (const name of ["gapSpeed", "segmentSampleStep"]) {
    if (!Number.isFinite(options[name]) || options[name] <= 0) {
      throw new TypeError(`${name} must be a finite positive number`);
    }
  }
  for (const name of ["gapConnectorsPerNode", "maxFallbackBridges"]) {
    if (!Number.isInteger(options[name]) || options[name] < 0) {
      throw new TypeError(`${name} must be a non-negative integer`);
    }
  }
  if (
    typeof options.maxFallbackBridgeDistance !== "number"
    || Number.isNaN(options.maxFallbackBridgeDistance)
    || options.maxFallbackBridgeDistance < 0
  ) {
    throw new TypeError(
      "maxFallbackBridgeDistance must be a non-negative number",
    );
  }
  if (typeof options.respectOneWay !== "boolean") {
    throw new TypeError("respectOneWay must be a boolean");
  }
  return options;
};

export const lineLength = (coordinates) => {
  validateCoordinates(coordinates, "coordinates");
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    length += coordinateDistance(coordinates[index - 1], coordinates[index]);
  }
  return length;
};

export const projectPointToLine = (point, coordinates) => {
  const normalizedPoint = finitePoint(point, "point");
  validateCoordinates(coordinates, "coordinates");
  let best = null;
  let cumulative = 0;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const [ax, ay] = coordinates[index];
    const [bx, by] = coordinates[index + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const squaredLength = dx * dx + dy * dy;
    if (squaredLength <= 0) continue;
    const segmentLength = Math.sqrt(squaredLength);
    const t = clamp(
      ((normalizedPoint.x - ax) * dx + (normalizedPoint.y - ay) * dy)
        / squaredLength,
      0,
      1,
    );
    const x = t === 0 ? ax : t === 1 ? bx : ax + t * dx;
    const y = t === 0 ? ay : t === 1 ? by : ay + t * dy;
    const projectionDistance = Math.hypot(
      normalizedPoint.x - x,
      normalizedPoint.y - y,
    );
    if (!best || projectionDistance < best.distance) {
      best = {
        index,
        t,
        x,
        y,
        distance: projectionDistance,
        distanceAlong: cumulative + t * segmentLength,
      };
    }
    cumulative += segmentLength;
  }
  return best;
};

const sliceLineByDistance = (coordinates, startDistance, endDistance) => {
  let from = startDistance;
  let to = endDistance;
  let reverse = false;
  if (to < from) {
    [from, to] = [to, from];
    reverse = true;
  }

  const output = [];
  let traveled = 0;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const [ax, ay] = coordinates[index];
    const [bx, by] = coordinates[index + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const segmentLength = Math.hypot(dx, dy);
    if (segmentLength <= 0) continue;
    const segmentStart = traveled;
    const segmentEnd = traveled + segmentLength;
    traveled = segmentEnd;
    if (segmentEnd < from) continue;
    if (segmentStart > to) break;

    const startT = (Math.max(from, segmentStart) - segmentStart) / segmentLength;
    const endT = (Math.min(to, segmentEnd) - segmentStart) / segmentLength;
    if (endT < startT) continue;
    const interpolate = (t) => {
      if (t === 0) return [ax, ay];
      if (t === 1) return [bx, by];
      return [ax + dx * t, ay + dy * t];
    };
    const start = interpolate(startT);
    const end = interpolate(endT);
    if (
      output.length === 0
      || coordinateDistance(output.at(-1), start) > Number.EPSILON
    ) {
      output.push(start);
    }
    if (coordinateDistance(output.at(-1), end) > Number.EPSILON) output.push(end);
  }
  if (output.length < 2) return null;
  return reverse ? output.reverse() : output;
};

class MinHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent].key <= this.items[index].key) break;
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }

  pop() {
    if (this.items.length === 0) return null;
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.items.length && this.items[left].key < this.items[smallest].key) {
          smallest = left;
        }
        if (right < this.items.length && this.items[right].key < this.items[smallest].key) {
          smallest = right;
        }
        if (smallest === index) break;
        [this.items[smallest], this.items[index]] = [this.items[index], this.items[smallest]];
        index = smallest;
      }
    }
    return top;
  }

  get size() {
    return this.items.length;
  }
}

class PointGrid {
  constructor(cellSize) {
    this.cellSize = Math.max(Number.EPSILON, cellSize);
    this.cells = new Map();
  }

  key(x, y) {
    return `${x}:${y}`;
  }

  insert(x, y, payload) {
    const cellX = Math.floor(x / this.cellSize);
    const cellY = Math.floor(y / this.cellSize);
    const key = this.key(cellX, cellY);
    const bucket = this.cells.get(key);
    const entry = { x, y, payload };
    if (bucket) bucket.push(entry);
    else this.cells.set(key, [entry]);
  }

  forEachWithin(x, y, radius, visit) {
    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minY = Math.floor((y - radius) / this.cellSize);
    const maxY = Math.floor((y + radius) / this.cellSize);
    const columns = maxX - minX + 1;
    const rows = maxY - minY + 1;
    const cellCount = columns * rows;
    const visitBucket = (bucket) => {
      if (!bucket) return;
      for (const entry of bucket) {
        const entryDistance = Math.hypot(x - entry.x, y - entry.y);
        if (entryDistance <= radius) visit(entry.payload, entryDistance);
      }
    };

    if (
      !Number.isSafeInteger(columns)
      || !Number.isSafeInteger(rows)
      || !Number.isSafeInteger(cellCount)
      || cellCount > Math.max(16, this.cells.size * 4)
    ) {
      for (const bucket of this.cells.values()) visitBucket(bucket);
      return;
    }

    for (let cellX = minX; cellX <= maxX; cellX += 1) {
      for (let cellY = minY; cellY <= maxY; cellY += 1) {
        visitBucket(this.cells.get(this.key(cellX, cellY)));
      }
    }
  }
}

class UnionFind {
  constructor() {
    this.parent = new Map();
  }

  find(value) {
    if (!this.parent.has(value)) {
      this.parent.set(value, value);
      return value;
    }
    let root = value;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let current = value;
    while (this.parent.get(current) !== root) {
      const next = this.parent.get(current);
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(a, b) {
    const aRoot = this.find(a);
    const bRoot = this.find(b);
    if (aRoot !== bRoot) this.parent.set(aRoot, bRoot);
  }
}

const normalizeNodes = (nodes) => {
  const normalized = new Map();
  if (nodes instanceof Map) {
    for (const [id, point] of nodes) {
      if (!isNodeId(id)) {
        throw new TypeError("node ids must be strings or finite numbers");
      }
      normalized.set(id, finitePoint(point, `node ${String(id)}`));
    }
    return normalized;
  }
  if (!Array.isArray(nodes)) {
    throw new TypeError("nodes must be a Map or an array");
  }
  for (const point of nodes) {
    const id = point?.id;
    if (!isNodeId(id)) {
      throw new TypeError("node ids must be strings or finite numbers");
    }
    if (normalized.has(id)) {
      throw new TypeError(`duplicate node id: ${String(id)}`);
    }
    normalized.set(id, finitePoint(point, `node ${String(id)}`));
  }
  return normalized;
};

const normalizeSegments = (
  segments,
  defaultSpeed,
  endpointTolerance,
  nodes,
) => {
  if (!Array.isArray(segments)) {
    throw new TypeError("segments must be an array");
  }
  const ids = new Set();
  const normalized = segments.map((segment) => {
    if (
      typeof segment !== "object"
      || segment === null
      || !isNodeId(segment.id)
      || !isNodeId(segment.from)
      || !isNodeId(segment.to)
    ) {
      throw new TypeError(
        "every segment needs string or finite-number id, from, and to values",
      );
    }
    if (ids.has(segment.id)) {
      throw new TypeError(`duplicate segment id: ${String(segment.id)}`);
    }
    ids.add(segment.id);
    const fromPoint = nodes.get(segment.from);
    const toPoint = nodes.get(segment.to);
    if (!fromPoint || !toPoint) {
      throw new TypeError(
        `segment ${String(segment.id)} references an unknown node`,
      );
    }
    if (!Array.isArray(segment.coordinates) || segment.coordinates.length < 2) {
      throw new TypeError(
        `segment ${String(segment.id)} needs at least two coordinates`,
      );
    }
    validateCoordinates(
      segment.coordinates,
      `segment ${String(segment.id)} coordinates`,
    );
    const coordinates = segment.coordinates
      .map((coordinate) => [coordinate[0], coordinate[1]]);
    const geometryStart = coordinates[0];
    const geometryEnd = coordinates.at(-1);
    if (
      coordinateDistance(geometryStart, [fromPoint.x, fromPoint.y])
        > endpointTolerance
      || coordinateDistance(geometryEnd, [toPoint.x, toPoint.y])
        > endpointTolerance
    ) {
      throw new TypeError(
        `segment ${String(segment.id)} geometry endpoints must be within `
          + "endpointTolerance of their nodes",
      );
    }
    const measuredLength = lineLength(coordinates);
    if (!Number.isFinite(measuredLength) || measuredLength <= 0) {
      throw new TypeError(
        `segment ${String(segment.id)} must have positive geometry length`,
      );
    }
    const length = segment.length === undefined
      ? measuredLength
      : segment.length;
    if (!Number.isFinite(length) || length <= 0) {
      throw new TypeError(
        `segment ${String(segment.id)} length must be a finite positive number`,
      );
    }
    const speed = segment.speed === undefined ? defaultSpeed : segment.speed;
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new TypeError(
        `segment ${String(segment.id)} speed must be a finite positive number`,
      );
    }
    if (segment.oneWay !== undefined && typeof segment.oneWay !== "boolean") {
      throw new TypeError(
        `segment ${String(segment.id)} oneWay must be a boolean`,
      );
    }
    return {
      ...segment,
      coordinates,
      geometryLength: measuredLength,
      length,
      speed,
      oneWay: segment.oneWay ?? false,
    };
  });
  return normalized.sort((a, b) => compareIds(a.id, b.id));
};

export class GapRouter {
  #adjacency;
  #canonicalOf;
  #components;
  #nextVirtualNumber;
  #nodeGrid;
  #nodePositions;
  #options;
  #rawNodes;
  #segmentGrid;
  #segments;
  #splitNodesBySegment;
  #stats;

  constructor(input) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new TypeError("router input must be an object");
    }
    const { nodes, segments, options = {} } = input;
    this.#options = Object.freeze(normalizeOptions(options));
    this.#rawNodes = normalizeNodes(nodes);
    this.#segments = normalizeSegments(
      segments,
      this.#options.gapSpeed,
      this.#options.endpointTolerance,
      this.#rawNodes,
    );
    this.#nodePositions = new Map();
    this.#canonicalOf = new Map();
    this.#adjacency = new Map();
    this.#components = new UnionFind();
    this.#splitNodesBySegment = new Map();
    this.#nextVirtualNumber = 1;
    this.#stats = {
      mergedNodes: 0,
      gapConnectors: 0,
      projectedDeadEnds: 0,
      fallbackBridges: 0,
    };
    this.#segmentGrid = new PointGrid(this.#options.segmentSampleStep);
    this.#nodeGrid = null;
    this.#mergeNodes();
    this.#buildSegmentEdges();
    this.#connectNearbyComponents();
  }

  #nextVirtualId() {
    for (;;) {
      const id = `@@gap-router:${this.#nextVirtualNumber}`;
      this.#nextVirtualNumber += 1;
      if (!this.#rawNodes.has(id) && !this.#nodePositions.has(id)) return id;
    }
  }

  #addEdge(from, to, edge) {
    const bucket = this.#adjacency.get(from);
    if (bucket) bucket.push({ to, edge });
    else this.#adjacency.set(from, [{ to, edge }]);
  }

  #mergeNodes() {
    const used = new Set();
    const directlyConnected = new Map();
    const rememberConnection = (from, to) => {
      if (!directlyConnected.has(from)) {
        directlyConnected.set(from, new Set());
      }
      directlyConnected.get(from).add(to);
    };
    for (const segment of this.#segments) {
      used.add(segment.from);
      used.add(segment.to);
      if (segment.from !== segment.to) {
        rememberConnection(segment.from, segment.to);
        rememberConnection(segment.to, segment.from);
      }
    }
    const orderedIds = [...used].sort((a, b) => {
      const aPoint = this.#rawNodes.get(a);
      const bPoint = this.#rawNodes.get(b);
      return aPoint.x - bPoint.x
        || aPoint.y - bPoint.y
        || compareIds(a, b);
    });
    const grid = new PointGrid(
      Math.max(this.#options.mergeTolerance * 2, 1),
    );
    const clusterMembers = new Map();
    for (const id of orderedIds) {
      const point = this.#rawNodes.get(id);
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      let canonical = null;
      let nearest = Infinity;
      grid.forEachWithin(
        point.x,
        point.y,
        this.#options.mergeTolerance,
        (candidate, candidateDistance) => {
          const wouldCollapseSegment = [...clusterMembers.get(candidate)]
            .some((member) => directlyConnected.get(id)?.has(member));
          if (wouldCollapseSegment) return;
          if (
            candidateDistance < nearest
            || (
              candidateDistance === nearest
              && canonical !== null
              && compareIds(candidate, canonical) < 0
            )
          ) {
            canonical = candidate;
            nearest = candidateDistance;
          }
        },
      );
      if (canonical !== null) {
        this.#canonicalOf.set(id, canonical);
        clusterMembers.get(canonical).add(id);
        this.#stats.mergedNodes += 1;
      } else {
        this.#canonicalOf.set(id, id);
        this.#nodePositions.set(id, point);
        clusterMembers.set(id, new Set([id]));
        grid.insert(point.x, point.y, id);
      }
    }
  }

  #sampleSegment(segment) {
    const step = this.#options.segmentSampleStep;
    let totalSamples = 0;
    for (let index = 0; index < segment.coordinates.length - 1; index += 1) {
      const [ax, ay] = segment.coordinates[index];
      const [bx, by] = segment.coordinates[index + 1];
      const length = Math.hypot(bx - ax, by - ay);
      const count = Math.max(1, Math.ceil(length / step));
      totalSamples += count + 1;
      if (
        !Number.isSafeInteger(count)
        || !Number.isSafeInteger(totalSamples)
        || totalSamples > MAX_SAMPLES_PER_SEGMENT
      ) {
        throw new RangeError(
          `segment ${String(segment.id)} requires too many spatial samples; `
            + "increase segmentSampleStep",
        );
      }
      for (let sample = 0; sample <= count; sample += 1) {
        const t = sample / count;
        const x = sample === 0
          ? ax
          : sample === count ? bx : ax + (bx - ax) * t;
        const y = sample === 0
          ? ay
          : sample === count ? by : ay + (by - ay) * t;
        this.#segmentGrid.insert(
          x,
          y,
          segment,
        );
      }
    }
  }

  #buildSegmentEdges() {
    for (const segment of this.#segments) {
      const from = this.#canonicalOf.get(segment.from);
      const to = this.#canonicalOf.get(segment.to);
      if (from === undefined || to === undefined) continue;
      const fromPoint = this.#nodePositions.get(from);
      const toPoint = this.#nodePositions.get(to);
      const coordinates = segment.coordinates
        .map((coordinate) => [coordinate[0], coordinate[1]]);
      coordinates[0] = [fromPoint.x, fromPoint.y];
      coordinates[coordinates.length - 1] = [toPoint.x, toPoint.y];
      segment.coordinates = coordinates;
      segment.geometryLength = lineLength(coordinates);
      if (segment.geometryLength <= GEOMETRY_EPSILON) continue;
      this.#sampleSegment(segment);
      const forward = {
        kind: "network",
        segmentId: segment.id,
        metadata: segment.metadata ?? null,
        length: segment.length,
        cost: segment.length / segment.speed,
        coordinates: segment.coordinates,
      };
      this.#addEdge(from, to, forward);
      if (!segment.oneWay || !this.#options.respectOneWay) {
        this.#addEdge(to, from, {
          ...forward,
          coordinates: segment.coordinates.slice().reverse(),
        });
      }
      this.#components.union(from, to);
    }
  }

  #gapEdge(from, to, reason) {
    const a = this.#nodePositions.get(from);
    const b = this.#nodePositions.get(to);
    const length = distance(a, b);
    return {
      kind: "gap",
      reason,
      length,
      cost: (length / this.#options.gapSpeed) * this.#options.gapCostFactor
        + (length > GEOMETRY_EPSILON ? this.#options.gapFixedCost : 0),
      coordinates: [[a.x, a.y], [b.x, b.y]],
    };
  }

  #connectNearbyComponents() {
    const nodeIds = [...this.#nodePositions.keys()].sort(compareIds);
    this.#nodeGrid = new PointGrid(
      Math.max(1, this.#options.maxGapDistance),
    );
    for (const id of nodeIds) {
      const point = this.#nodePositions.get(id);
      this.#nodeGrid.insert(point.x, point.y, id);
    }
    if (this.#options.maxGapDistance <= 0) return;

    const linked = new Map();
    const hasLink = (from, to) => linked.get(from)?.has(to) ?? false;
    const rememberLink = (from, to) => {
      if (!linked.has(from)) linked.set(from, new Set());
      if (!linked.has(to)) linked.set(to, new Set());
      linked.get(from).add(to);
      linked.get(to).add(from);
    };
    for (const id of nodeIds) {
      const point = this.#nodePositions.get(id);
      const root = this.#components.find(id);
      const candidates = [];
      this.#nodeGrid.forEachWithin(
        point.x,
        point.y,
        this.#options.maxGapDistance,
        (other, candidateDistance) => {
          if (other !== id && this.#components.find(other) !== root) {
            candidates.push({ id: other, distance: candidateDistance });
          }
        },
      );
      candidates.sort(
        (a, b) => a.distance - b.distance || compareIds(a.id, b.id),
      );
      let added = 0;
      for (const candidate of candidates) {
        if (added >= this.#options.gapConnectorsPerNode) break;
        if (hasLink(id, candidate.id)) continue;
        if (
          this.#components.find(id)
          === this.#components.find(candidate.id)
        ) {
          continue;
        }
        rememberLink(id, candidate.id);
        const edge = this.#gapEdge(id, candidate.id, "nearby-components");
        this.#addEdge(id, candidate.id, edge);
        this.#addEdge(candidate.id, id, {
          ...edge,
          coordinates: edge.coordinates.slice().reverse(),
        });
        this.#components.union(id, candidate.id);
        this.#stats.gapConnectors += 1;
        added += 1;
      }
    }

    const networkDegree = new Map();
    for (const [from, edges] of this.#adjacency) {
      for (const { to, edge } of edges) {
        if (edge.kind !== "network") continue;
        if (!networkDegree.has(from)) networkDegree.set(from, new Set());
        networkDegree.get(from).add(to);
      }
    }

    for (const id of nodeIds) {
      if ((networkDegree.get(id)?.size ?? 0) > 1) continue;
      const point = this.#nodePositions.get(id);
      const root = this.#components.find(id);
      let nearestForeignNode = Infinity;
      this.#nodeGrid.forEachWithin(
        point.x,
        point.y,
        this.#options.maxGapDistance,
        (other, candidateDistance) => {
          if (other !== id && this.#components.find(other) !== root) {
            nearestForeignNode = Math.min(
              nearestForeignNode,
              candidateDistance,
            );
          }
        },
      );
      let best = null;
      const seen = new Set();
      this.#segmentGrid.forEachWithin(
        point.x,
        point.y,
        this.#options.maxGapDistance + this.#options.segmentSampleStep,
        (segment) => {
          if (seen.has(segment.id)) return;
          seen.add(segment.id);
          const segmentRoot = this.#components.find(
            this.#canonicalOf.get(segment.from),
          );
          if (segmentRoot === root) return;
          const projection = projectPointToLine(point, segment.coordinates);
          if (
            !projection
            || projection.distance > this.#options.maxGapDistance
          ) {
            return;
          }
          if (
            !best
            || projection.distance < best.projection.distance
            || (
              projection.distance === best.projection.distance
              && compareIds(segment.id, best.segment.id) < 0
            )
          ) {
            best = { segment, projection };
          }
        },
      );
      if (!best) continue;
      if (
        best.projection.distance
        > nearestForeignNode - this.#options.projectionMinGain
      ) {
        continue;
      }
      const attached = this.#attachProjection(best.segment, best.projection);
      const edge = this.#gapEdge(id, attached.nodeId, "dead-end-projection");
      this.#addEdge(id, attached.nodeId, edge);
      this.#addEdge(attached.nodeId, id, {
        ...edge,
        coordinates: edge.coordinates.slice().reverse(),
      });
      this.#components.union(id, attached.nodeId);
      this.#stats.projectedDeadEnds += 1;
    }
  }

  #attachProjection(segment, projection) {
    const from = this.#canonicalOf.get(segment.from);
    const to = this.#canonicalOf.get(segment.to);
    const endpointEpsilon = Math.max(
      GEOMETRY_EPSILON,
      segment.geometryLength * Number.EPSILON * 16,
    );
    if (projection.distanceAlong <= endpointEpsilon) {
      const point = this.#nodePositions.get(from);
      return { nodeId: from, ...point };
    }
    if (
      segment.geometryLength - projection.distanceAlong
      <= endpointEpsilon
    ) {
      const point = this.#nodePositions.get(to);
      return { nodeId: to, ...point };
    }

    const nodeId = this.#nextVirtualId();
    const point = { x: projection.x, y: projection.y };
    this.#nodePositions.set(nodeId, point);
    const oneWay = segment.oneWay && this.#options.respectOneWay;
    const lengthScale = segment.geometryLength > 0
      ? segment.length / segment.geometryLength
      : 1;
    const beforeLength = projection.distanceAlong * lengthScale;
    const afterLength = Math.max(0, segment.length - beforeLength);

    const partial = (coordinates, length) => ({
      kind: "network",
      segmentId: segment.id,
      metadata: segment.metadata ?? null,
      length,
      cost: length / segment.speed,
      coordinates,
    });

    const before = sliceLineByDistance(segment.coordinates, 0, projection.distanceAlong);
    const after = sliceLineByDistance(
      segment.coordinates,
      projection.distanceAlong,
      segment.geometryLength,
    );
    if (before) {
      const fromPoint = this.#nodePositions.get(from);
      before[0] = [fromPoint.x, fromPoint.y];
      before[before.length - 1] = [point.x, point.y];
    }
    if (after) {
      const toPoint = this.#nodePositions.get(to);
      after[0] = [point.x, point.y];
      after[after.length - 1] = [toPoint.x, toPoint.y];
    }
    if (before && beforeLength > 1e-6) {
      this.#addEdge(from, nodeId, partial(before, beforeLength));
      if (!oneWay) {
        this.#addEdge(nodeId, from, partial(before.slice().reverse(), beforeLength));
      }
    }
    if (after && afterLength > 1e-6) {
      this.#addEdge(nodeId, to, partial(after, afterLength));
      if (!oneWay) {
        this.#addEdge(to, nodeId, partial(after.slice().reverse(), afterLength));
      }
    }
    this.#components.union(nodeId, from);

    const siblings = this.#splitNodesBySegment.get(segment.id) ?? [];
    for (const sibling of siblings) {
      const coordinates = sliceLineByDistance(
        segment.coordinates,
        sibling.distanceAlong,
        projection.distanceAlong,
      );
      const geometryLength = Math.abs(
        sibling.distanceAlong - projection.distanceAlong,
      );
      const partialLength = geometryLength * lengthScale;
      if (!coordinates || partialLength <= 1e-6) continue;
      const siblingPoint = this.#nodePositions.get(sibling.nodeId);
      coordinates[0] = [siblingPoint.x, siblingPoint.y];
      coordinates[coordinates.length - 1] = [point.x, point.y];
      const siblingBefore = sibling.distanceAlong <= projection.distanceAlong;
      if (siblingBefore) {
        this.#addEdge(
          sibling.nodeId,
          nodeId,
          partial(coordinates, partialLength),
        );
        if (!oneWay) {
          this.#addEdge(
            nodeId,
            sibling.nodeId,
            partial(coordinates.slice().reverse(), partialLength),
          );
        }
      } else {
        this.#addEdge(
          nodeId,
          sibling.nodeId,
          partial(coordinates.slice().reverse(), partialLength),
        );
        if (!oneWay) {
          this.#addEdge(
            sibling.nodeId,
            nodeId,
            partial(coordinates, partialLength),
          );
        }
      }
    }
    siblings.push({ nodeId, distanceAlong: projection.distanceAlong });
    this.#splitNodesBySegment.set(segment.id, siblings);
    return { nodeId, ...point };
  }

  #nearbySegments(point, maxDistance) {
    const candidates = [];
    const seen = new Set();
    this.#segmentGrid.forEachWithin(
      point.x,
      point.y,
      maxDistance + this.#options.segmentSampleStep,
      (segment) => {
        if (seen.has(segment.id)) return;
        seen.add(segment.id);
        const projection = projectPointToLine(point, segment.coordinates);
        if (projection && projection.distance <= maxDistance) {
          candidates.push({ segment, projection });
        }
      },
    );
    return candidates.sort(
      (a, b) => a.projection.distance - b.projection.distance
        || compareIds(a.segment.id, b.segment.id),
    );
  }

  #attachAnchor(point, maxDistance, candidateCount) {
    const candidates = this.#nearbySegments(point, maxDistance);
    if (candidates.length === 0) return null;
    const nodeId = this.#nextVirtualId();
    this.#nodePositions.set(nodeId, { x: point.x, y: point.y });
    let attached = 0;
    let bestDistance = Infinity;
    const targets = new Set();
    for (const { segment, projection } of candidates) {
      if (attached >= candidateCount) break;
      if (
        attached > 0
        && projection.distance > candidates[0].projection.distance * 2 + maxDistance * 0.15
      ) {
        break;
      }
      const target = this.#attachProjection(segment, projection);
      if (targets.has(target.nodeId)) continue;
      targets.add(target.nodeId);
      const edge = this.#gapEdge(nodeId, target.nodeId, "anchor-snap");
      this.#addEdge(nodeId, target.nodeId, edge);
      this.#addEdge(target.nodeId, nodeId, {
        ...edge,
        coordinates: edge.coordinates.slice().reverse(),
      });
      this.#components.union(nodeId, target.nodeId);
      bestDistance = Math.min(bestDistance, projection.distance);
      attached += 1;
    }
    return attached > 0 ? { nodeId, distance: bestDistance } : null;
  }

  #minimumCostPerDistance() {
    let minimum = Infinity;
    for (const [from, edges] of this.#adjacency) {
      const fromPoint = this.#nodePositions.get(from);
      if (!fromPoint) continue;
      for (const { to, edge } of edges) {
        const toPoint = this.#nodePositions.get(to);
        if (!toPoint) continue;
        const spatialDistance = distance(fromPoint, toPoint);
        if (spatialDistance <= 0) continue;
        minimum = Math.min(minimum, edge.cost / spatialDistance);
      }
    }
    return Number.isFinite(minimum) && minimum >= 0 ? minimum : 0;
  }

  #search(startId, goalId) {
    const goal = this.#nodePositions.get(goalId);
    // Custom logical lengths can be shorter than geometric lengths, and gap
    // cost factors can be below one. Deriving the lower bound from the actual
    // query graph keeps the A* heuristic admissible for every valid option.
    const minimumCostPerDistance = this.#minimumCostPerDistance();
    const heuristic = (nodeId) => {
      const point = this.#nodePositions.get(nodeId);
      return point && goal
        ? distance(point, goal) * minimumCostPerDistance
        : 0;
    };
    const scores = new Map([[startId, 0]]);
    const previous = new Map();
    const visited = new Set();
    const queue = new MinHeap();
    queue.push({ key: heuristic(startId), nodeId: startId });

    while (queue.size > 0) {
      const current = queue.pop();
      if (visited.has(current.nodeId)) continue;
      visited.add(current.nodeId);
      if (current.nodeId === goalId) break;
      const currentScore = scores.get(current.nodeId);
      for (
        const { to, edge }
        of this.#adjacency.get(current.nodeId) ?? []
      ) {
        if (visited.has(to)) continue;
        const candidate = currentScore + edge.cost;
        if (!scores.has(to) || candidate < scores.get(to)) {
          scores.set(to, candidate);
          previous.set(to, { nodeId: current.nodeId, edge });
          queue.push({ key: candidate + heuristic(to), nodeId: to });
        }
      }
    }
    return { scores, previous, reached: visited.has(goalId) };
  }

  #reverseReachable(goalId) {
    const reverse = new Map();
    for (const [from, edges] of this.#adjacency) {
      for (const { to, edge } of edges) {
        if (!reverse.has(to)) reverse.set(to, []);
        reverse.get(to).push({ to: from, edge });
      }
    }
    const scores = new Map([[goalId, 0]]);
    const queue = new MinHeap();
    queue.push({ key: 0, nodeId: goalId });
    while (queue.size > 0) {
      const current = queue.pop();
      if (current.key !== scores.get(current.nodeId)) continue;
      for (const { to, edge } of reverse.get(current.nodeId) ?? []) {
        const candidate = current.key + edge.cost;
        if (!scores.has(to) || candidate < scores.get(to)) {
          scores.set(to, candidate);
          queue.push({ key: candidate, nodeId: to });
        }
      }
    }
    return scores;
  }

  #addFallbackBridge(forward, backward, maxDistance) {
    let best = null;
    const networkNodes = new Set();
    for (const [from, edges] of this.#adjacency) {
      for (const { to, edge } of edges) {
        if (edge.kind === "network") {
          networkNodes.add(from);
          networkNodes.add(to);
        }
      }
    }
    const consider = (from, to) => {
      if (forward.has(to)) return;
      if (!networkNodes.has(from) || !networkNodes.has(to)) return;
      if (
        this.#components.find(from)
        === this.#components.find(to)
      ) {
        return;
      }
      const a = this.#nodePositions.get(from);
      const b = this.#nodePositions.get(to);
      if (!a || !b) return;
      const candidateDistance = distance(a, b);
      if (candidateDistance > maxDistance) return;
      if (
        !best
        || candidateDistance < best.distance
        || (
          candidateDistance === best.distance
          && (
            compareIds(from, best.from) < 0
            || (
              compareIds(from, best.from) === 0
              && compareIds(to, best.to) < 0
            )
          )
        )
      ) {
        best = { from, to, distance: candidateDistance };
      }
    };

    for (const from of forward.keys()) {
      for (const to of backward.keys()) consider(from, to);
    }
    if (!best) {
      for (const from of forward.keys()) {
        for (const to of this.#nodePositions.keys()) consider(from, to);
      }
    }
    if (!best) return false;
    const edge = this.#gapEdge(best.from, best.to, "fallback-bridge");
    this.#addEdge(best.from, best.to, edge);
    this.#addEdge(best.to, best.from, {
      ...edge,
      coordinates: edge.coordinates.slice().reverse(),
    });
    this.#components.union(best.from, best.to);
    this.#stats.fallbackBridges += 1;
    return true;
  }

  #reconstruct(startId, goalId, previous) {
    const legs = [];
    let current = goalId;
    while (current !== startId) {
      const step = previous.get(current);
      if (!step) return null;
      legs.push(step.edge);
      current = step.nodeId;
    }
    return legs.reverse();
  }

  #snapshotQueryState() {
    return {
      adjacency: new Map(
        [...this.#adjacency].map(([id, edges]) => [id, edges.slice()]),
      ),
      nodePositions: new Map(this.#nodePositions),
      componentParents: new Map(this.#components.parent),
      splitNodesBySegment: new Map(
        [...this.#splitNodesBySegment]
          .map(([id, nodes]) => [id, nodes.slice()]),
      ),
      nextVirtualNumber: this.#nextVirtualNumber,
      stats: { ...this.#stats },
    };
  }

  #restoreQueryState(snapshot) {
    this.#adjacency = snapshot.adjacency;
    this.#nodePositions = snapshot.nodePositions;
    this.#components.parent = snapshot.componentParents;
    this.#splitNodesBySegment = snapshot.splitNodesBySegment;
    this.#nextVirtualNumber = snapshot.nextVirtualNumber;
    this.#stats = snapshot.stats;
  }

  route(start, goal, options = {}) {
    if (
      typeof options !== "object"
      || options === null
      || Array.isArray(options)
    ) {
      throw new TypeError("route options must be an object");
    }
    for (const name of Object.keys(options)) {
      if (!ROUTE_OPTION_NAMES.has(name)) {
        throw new TypeError(`unknown route option: ${name}`);
      }
    }
    const startPoint = finitePoint(start, "start");
    const goalPoint = finitePoint(goal, "goal");
    const maxSnapDistance = options.maxSnapDistance
      ?? Math.min(Number.MAX_VALUE, this.#options.maxGapDistance * 2);
    const anchorCandidateCount = options.anchorCandidateCount ?? 3;
    const maxFallbackBridges = options.maxFallbackBridges
      ?? this.#options.maxFallbackBridges;
    const maxFallbackBridgeDistance = options.maxFallbackBridgeDistance
      ?? this.#options.maxFallbackBridgeDistance;
    if (!Number.isFinite(maxSnapDistance) || maxSnapDistance < 0) {
      throw new TypeError(
        "maxSnapDistance must be a finite non-negative number",
      );
    }
    if (
      !Number.isInteger(anchorCandidateCount)
      || anchorCandidateCount <= 0
    ) {
      throw new TypeError("anchorCandidateCount must be a positive integer");
    }
    if (
      !Number.isInteger(maxFallbackBridges)
      || maxFallbackBridges < 0
    ) {
      throw new TypeError("maxFallbackBridges must be a non-negative integer");
    }
    if (
      typeof maxFallbackBridgeDistance !== "number"
      || Number.isNaN(maxFallbackBridgeDistance)
      || maxFallbackBridgeDistance < 0
    ) {
      throw new TypeError(
        "maxFallbackBridgeDistance must be a non-negative number",
      );
    }

    const snapshot = this.#snapshotQueryState();
    try {
      const startAnchor = this.#attachAnchor(
        startPoint,
        maxSnapDistance,
        anchorCandidateCount,
      );
      if (!startAnchor) {
        return { ok: false, reason: "start-not-near-network" };
      }
      if (startPoint.x === goalPoint.x && startPoint.y === goalPoint.y) {
        return {
          ok: true,
          coordinates: [[startPoint.x, startPoint.y]],
          legs: [],
          distance: 0,
          cost: 0,
          snapDistance: {
            start: startAnchor.distance,
            goal: startAnchor.distance,
          },
          diagnostics: { ...this.#stats },
        };
      }
      const goalAnchor = this.#attachAnchor(
        goalPoint,
        maxSnapDistance,
        anchorCandidateCount,
      );
      if (!goalAnchor) {
        return { ok: false, reason: "goal-not-near-network" };
      }

      let search;
      for (let attempt = 0; ; attempt += 1) {
        search = this.#search(startAnchor.nodeId, goalAnchor.nodeId);
        if (search.reached) break;
        if (attempt >= maxFallbackBridges) break;
        const backward = this.#reverseReachable(goalAnchor.nodeId);
        if (!this.#addFallbackBridge(
          search.scores,
          backward,
          maxFallbackBridgeDistance,
        )) {
          break;
        }
      }
      if (!search?.reached) return { ok: false, reason: "no-route" };

      const path = this.#reconstruct(
        startAnchor.nodeId,
        goalAnchor.nodeId,
        search.previous,
      );
      const legs = path
        .filter(
          (leg) => leg.length > GEOMETRY_EPSILON
            || leg.cost > GEOMETRY_EPSILON,
        )
        .map((leg) => ({
          ...leg,
          coordinates: leg.coordinates
            .map((coordinate) => [coordinate[0], coordinate[1]]),
        }));
      const coordinates = [];
      for (const leg of legs) {
        for (const coordinate of leg.coordinates) {
          if (
            coordinates.length === 0
            || coordinateDistance(coordinates.at(-1), coordinate)
              > GEOMETRY_EPSILON
          ) {
            coordinates.push([coordinate[0], coordinate[1]]);
          }
        }
      }
      return {
        ok: true,
        coordinates,
        legs,
        distance: legs.reduce((sum, leg) => sum + leg.length, 0),
        cost: legs.reduce((sum, leg) => sum + leg.cost, 0),
        snapDistance: {
          start: startAnchor.distance,
          goal: goalAnchor.distance,
        },
        diagnostics: { ...this.#stats },
      };
    } finally {
      this.#restoreQueryState(snapshot);
    }
  }
}

export const createRouter = (input) => new GapRouter(input);
