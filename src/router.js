import { robustProjection } from "./numerics.js";

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
const OPTION_NAMES = new Set(Object.keys(DEFAULTS));
const ROUTE_OPTION_NAMES = new Set([
  "anchorCandidateCount",
  "maxFallbackBridgeDistance",
  "maxFallbackBridges",
  "maxSnapDistance",
]);
const LIMIT_DEFAULTS = Object.freeze({
  maxNodes: Infinity,
  maxSegments: Infinity,
  maxCoordinates: Infinity,
  maxSpatialSamplesTotal: Number.MAX_SAFE_INTEGER,
  maxCandidateEvaluations: Infinity,
  maxSearchExpansions: Infinity,
  maxFallbackPairEvaluations: Infinity,
});
const LIMIT_NAMES = new Set(Object.keys(LIMIT_DEFAULTS));
const LIMIT_CODES = Object.freeze({
  maxNodes: "MAX_NODES",
  maxSegments: "MAX_SEGMENTS",
  maxCoordinates: "MAX_COORDINATES",
  maxSpatialSamplesTotal: "MAX_SPATIAL_SAMPLES_TOTAL",
  maxCandidateEvaluations: "MAX_CANDIDATE_EVALUATIONS",
  maxSearchExpansions: "MAX_SEARCH_EXPANSIONS",
  maxFallbackPairEvaluations: "MAX_FALLBACK_PAIR_EVALUATIONS",
});
const projectionDistanceToEnd = new WeakMap();
const projectionOrderNumerator = new WeakMap();

export class RouterLimitError extends RangeError {
  constructor(code, phase, limit, actual) {
    super(`router execution limit exceeded: ${code}`);
    this.name = "RouterLimitError";
    this.code = code;
    this.phase = phase;
    this.limit = limit;
    this.actual = actual;
  }
}

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

const compareDyadicTokens = (left, right) => {
  const exponent = Math.min(left.exponent, right.exponent);
  const leftCoefficient = (
    left.coefficient << BigInt(left.exponent - exponent)
  );
  const rightCoefficient = (
    right.coefficient << BigInt(right.exponent - exponent)
  );
  return leftCoefficient < rightCoefficient
    ? -1
    : leftCoefficient > rightCoefficient
      ? 1
      : 0;
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
      throw new TypeError("unknown router option");
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

const normalizeLimits = (overrides) => {
  if (
    typeof overrides !== "object"
    || overrides === null
    || Array.isArray(overrides)
  ) {
    throw new TypeError("limits must be an object");
  }
  const limits = { ...LIMIT_DEFAULTS };
  for (const [name, value] of Object.entries(overrides)) {
    if (!LIMIT_NAMES.has(name)) {
      throw new TypeError("unknown router limit");
    }
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
    limits[name] = value;
  }
  return limits;
};

const enforceLimit = (limits, name, phase, actual) => {
  const limit = limits[name];
  if (actual > limit) {
    throw new RouterLimitError(LIMIT_CODES[name], phase, limit, actual);
  }
};

const finiteTravelCost = (length, speed, label) => {
  const cost = length / speed;
  if (!Number.isFinite(cost)) {
    throw new TypeError(`${label} cost must remain finite`);
  }
  return cost;
};

const splitProportionalLength = (total, beforeWeight, afterWeight) => {
  if (beforeWeight === 0) return [0, total];
  if (afterWeight === 0) return [total, 0];
  const scale = Math.max(beforeWeight, afterWeight);
  let beforeScaled = beforeWeight / scale;
  let afterScaled = afterWeight / scale;
  if (beforeScaled === 0) beforeScaled = Number.MIN_VALUE;
  if (afterScaled === 0) afterScaled = Number.MIN_VALUE;
  const denominator = beforeScaled + afterScaled;
  let before;
  let after;
  if (beforeScaled <= afterScaled) {
    before = total * (beforeScaled / denominator);
    if (before === 0) before = Number.MIN_VALUE;
    after = total - before;
    if (after === 0) after = Number.MIN_VALUE;
  } else {
    after = total * (afterScaled / denominator);
    if (after === 0) after = Number.MIN_VALUE;
    before = total - after;
    if (before === 0) before = Number.MIN_VALUE;
  }
  return [before, after];
};

export const lineLength = (coordinates) => {
  validateCoordinates(coordinates, "coordinates");
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    length += coordinateDistance(coordinates[index - 1], coordinates[index]);
    if (!Number.isFinite(length)) {
      throw new TypeError("coordinate length must remain finite");
    }
  }
  return length;
};

export const projectPointToLine = (point, coordinates) => {
  const normalizedPoint = finitePoint(point, "point");
  validateCoordinates(coordinates, "coordinates");
  let best = null;
  let cumulative = 0;
  let distanceAfterBest = 0;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const [ax, ay] = coordinates[index];
    const [bx, by] = coordinates[index + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const segmentLength = Math.hypot(dx, dy);
    if (!Number.isFinite(segmentLength)) {
      throw new TypeError("segment length must remain finite");
    }
    if (best) {
      distanceAfterBest += segmentLength;
      if (!Number.isFinite(distanceAfterBest)) {
        throw new TypeError("coordinate length must remain finite");
      }
    }
    if (segmentLength === 0) continue;
    const projection = robustProjection(
      [normalizedPoint.x, normalizedPoint.y],
      coordinates[index],
      coordinates[index + 1],
      [dx, dy],
    );
    const t = projection.fraction;
    const [x, y] = projection.position;
    const projectionDistance = projection.distance;
    if (!Number.isFinite(projectionDistance)) {
      throw new TypeError("projection distance must remain finite");
    }
    const distanceAlong = cumulative + projection.distanceAlong;
    if (!Number.isFinite(distanceAlong)) {
      throw new TypeError("projection distance along line must remain finite");
    }
    if (!best || projectionDistance < best.distance) {
      best = {
        index,
        t,
        x,
        y,
        distance: projectionDistance,
        distanceAlong,
      };
      projectionDistanceToEnd.set(best, projection.distanceToEnd);
      projectionOrderNumerator.set(best, projection.orderNumerator);
      distanceAfterBest = 0;
    }
    cumulative += segmentLength;
    if (!Number.isFinite(cumulative)) {
      throw new TypeError("coordinate length must remain finite");
    }
  }
  if (best) {
    const remaining = (
      projectionDistanceToEnd.get(best) + distanceAfterBest
    );
    if (!Number.isFinite(remaining)) {
      throw new TypeError("coordinate length must remain finite");
    }
    projectionDistanceToEnd.set(best, remaining);
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
      || coordinateDistance(output.at(-1), start) > 0
    ) {
      output.push(start);
    }
    if (coordinateDistance(output.at(-1), end) > 0) output.push(end);
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

  forEachWithin(x, y, radius, visit, inspect = () => {}) {
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
        inspect();
        const entryDistance = Math.hypot(x - entry.x, y - entry.y);
        if (entryDistance <= radius) visit(entry.payload, entryDistance);
      }
    };

    if (
      !Number.isSafeInteger(minX)
      || !Number.isSafeInteger(maxX)
      || !Number.isSafeInteger(minY)
      || !Number.isSafeInteger(maxY)
      || !Number.isSafeInteger(columns)
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
      normalized.set(id, finitePoint(point, "node"));
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
      throw new TypeError("duplicate node id");
    }
    normalized.set(id, finitePoint(point, "node"));
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
      throw new TypeError("duplicate segment id");
    }
    ids.add(segment.id);
    const fromPoint = nodes.get(segment.from);
    const toPoint = nodes.get(segment.to);
    if (!fromPoint || !toPoint) {
      throw new TypeError("segment references an unknown node");
    }
    if (!Array.isArray(segment.coordinates) || segment.coordinates.length < 2) {
      throw new TypeError("segment needs at least two coordinates");
    }
    validateCoordinates(
      segment.coordinates,
      "segment coordinates",
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
        "segment geometry endpoints must be within "
          + "endpointTolerance of their nodes",
      );
    }
    const measuredLength = lineLength(coordinates);
    if (!Number.isFinite(measuredLength) || measuredLength <= 0) {
      throw new TypeError("segment must have positive geometry length");
    }
    const length = segment.length === undefined
      ? measuredLength
      : segment.length;
    if (!Number.isFinite(length) || length <= 0) {
      throw new TypeError(
        "segment length must be a finite positive number",
      );
    }
    const speed = segment.speed === undefined ? defaultSpeed : segment.speed;
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new TypeError(
        "segment speed must be a finite positive number",
      );
    }
    if (segment.oneWay !== undefined && typeof segment.oneWay !== "boolean") {
      throw new TypeError("segment oneWay must be a boolean");
    }
    const cost = finiteTravelCost(
      length,
      speed,
      "segment travel",
    );
    return {
      ...segment,
      coordinates,
      geometryLength: measuredLength,
      length,
      speed,
      cost,
      oneWay: segment.oneWay ?? false,
    };
  });
  return normalized.sort((a, b) => compareIds(a.id, b.id));
};

export class GapRouter {
  #adjacency;
  #candidateEvaluations;
  #canonicalOf;
  #components;
  #fallbackPairEvaluations;
  #limits;
  #nextVirtualNumber;
  #nodeGrid;
  #nodePositions;
  #options;
  #rawNodes;
  #searchExpansions;
  #segmentGrid;
  #segments;
  #spatialSamplesTotal;
  #splitNodesBySegment;
  #stats;

  constructor(input) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new TypeError("router input must be an object");
    }
    const {
      nodes,
      segments,
      options = {},
      limits = {},
    } = input;
    this.#limits = Object.freeze(normalizeLimits(limits));
    this.#preflightLimits(nodes, segments);
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
    this.#candidateEvaluations = 0;
    this.#searchExpansions = 0;
    this.#fallbackPairEvaluations = 0;
    this.#spatialSamplesTotal = 0;
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

  #preflightLimits(nodes, segments) {
    if (nodes instanceof Map || Array.isArray(nodes)) {
      enforceLimit(
        this.#limits,
        "maxNodes",
        "input",
        nodes instanceof Map ? nodes.size : nodes.length,
      );
    }
    if (!Array.isArray(segments)) return;
    enforceLimit(
      this.#limits,
      "maxSegments",
      "input",
      segments.length,
    );
    let coordinateCount = 0;
    for (const segment of segments) {
      if (!Array.isArray(segment?.coordinates)) continue;
      coordinateCount += segment.coordinates.length;
      enforceLimit(
        this.#limits,
        "maxCoordinates",
        "input",
        coordinateCount,
      );
    }
  }

  #countCandidateEvaluation() {
    if (this.#limits.maxCandidateEvaluations === Infinity) return;
    this.#candidateEvaluations += 1;
    enforceLimit(
      this.#limits,
      "maxCandidateEvaluations",
      "candidate-generation",
      this.#candidateEvaluations,
    );
  }

  #countSearchExpansion() {
    if (this.#limits.maxSearchExpansions === Infinity) return;
    this.#searchExpansions += 1;
    enforceLimit(
      this.#limits,
      "maxSearchExpansions",
      "search",
      this.#searchExpansions,
    );
  }

  #countFallbackPairEvaluation() {
    if (this.#limits.maxFallbackPairEvaluations === Infinity) return;
    this.#fallbackPairEvaluations += 1;
    enforceLimit(
      this.#limits,
      "maxFallbackPairEvaluations",
      "fallback",
      this.#fallbackPairEvaluations,
    );
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
          let wouldCollapseSegment = false;
          for (const member of clusterMembers.get(candidate)) {
            this.#countCandidateEvaluation();
            if (directlyConnected.get(id)?.has(member)) {
              wouldCollapseSegment = true;
              break;
            }
          }
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
        () => this.#countCandidateEvaluation(),
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
      if (!Number.isSafeInteger(count)) {
        throw new RangeError(
          "segment requires too many spatial samples; increase segmentSampleStep",
        );
      }
      const samples = count + 1;
      const nextSegmentSamples = totalSamples + samples;
      const nextSpatialSamples = this.#spatialSamplesTotal + samples;
      if (
        !Number.isSafeInteger(nextSegmentSamples)
        || !Number.isSafeInteger(nextSpatialSamples)
      ) {
        throw new RouterLimitError(
          LIMIT_CODES.maxSpatialSamplesTotal,
          "spatial-index",
          this.#limits.maxSpatialSamplesTotal,
          Number.MAX_SAFE_INTEGER + 1,
        );
      }
      enforceLimit(
        this.#limits,
        "maxSpatialSamplesTotal",
        "spatial-index",
        nextSpatialSamples,
      );
      if (nextSegmentSamples > MAX_SAMPLES_PER_SEGMENT) {
        throw new RangeError(
          "segment requires too many spatial samples; increase segmentSampleStep",
        );
      }
      totalSamples = nextSegmentSamples;
      this.#spatialSamplesTotal = nextSpatialSamples;
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
      if (segment.geometryLength === 0) continue;
      this.#sampleSegment(segment);
      const forward = {
        kind: "network",
        segmentId: segment.id,
        metadata: segment.metadata ?? null,
        length: segment.length,
        cost: segment.cost,
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

  #gapEdge(from, to, reason, knownLength) {
    const a = this.#nodePositions.get(from);
    const b = this.#nodePositions.get(to);
    const length = knownLength ?? distance(a, b);
    if (
      typeof length !== "number"
      || !Number.isFinite(length)
      || length < 0
    ) {
      throw new TypeError("gap length must be a finite non-negative number");
    }
    const travelCost = finiteTravelCost(
      length,
      this.#options.gapSpeed,
      "gap",
    );
    const cost = travelCost * this.#options.gapCostFactor
      + (length > 0 ? this.#options.gapFixedCost : 0);
    if (!Number.isFinite(cost)) {
      throw new TypeError("gap cost must remain finite");
    }
    return {
      kind: "gap",
      reason,
      length,
      cost,
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
        () => this.#countCandidateEvaluation(),
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
        () => this.#countCandidateEvaluation(),
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
        () => this.#countCandidateEvaluation(),
      );
      if (!best) continue;
      if (
        best.projection.distance
        > nearestForeignNode - this.#options.projectionMinGain
      ) {
        continue;
      }
      const attached = this.#attachProjection(best.segment, best.projection);
      const edge = this.#gapEdge(
        id,
        attached.nodeId,
        "dead-end-projection",
        best.projection.distance,
      );
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
    if (projection.index === 0 && projection.t === 0) {
      const point = this.#nodePositions.get(from);
      return { nodeId: from, ...point };
    }
    if (
      projection.index === segment.coordinates.length - 2
      && projection.t === 1
    ) {
      const point = this.#nodePositions.get(to);
      return { nodeId: to, ...point };
    }

    const nodeId = this.#nextVirtualId();
    const point = { x: projection.x, y: projection.y };
    this.#nodePositions.set(nodeId, point);
    const oneWay = segment.oneWay && this.#options.respectOneWay;
    const beforeGeometryLength = projection.distanceAlong;
    const afterGeometryLength = (
      projectionDistanceToEnd.get(projection)
      ?? Math.max(0, segment.geometryLength - beforeGeometryLength)
    );
    const [beforeLength, afterLength] = (
      segment.length === segment.geometryLength
        ? [beforeGeometryLength, afterGeometryLength]
        : splitProportionalLength(
          segment.length,
          beforeGeometryLength,
          afterGeometryLength,
        )
    );
    const orderNumerator = projectionOrderNumerator.get(projection);

    const partial = (coordinates, length) => ({
      kind: "network",
      segmentId: segment.id,
      metadata: segment.metadata ?? null,
      length,
      cost: finiteTravelCost(length, segment.speed, "projected segment"),
      coordinates,
    });

    const fromPoint = this.#nodePositions.get(from);
    const toPoint = this.#nodePositions.get(to);
    let before = sliceLineByDistance(
      segment.coordinates,
      0,
      projection.distanceAlong,
    );
    let after = sliceLineByDistance(
      segment.coordinates,
      projection.distanceAlong,
      segment.geometryLength,
    );
    if (!before && beforeGeometryLength > 0) {
      before = [[fromPoint.x, fromPoint.y], [point.x, point.y]];
    }
    if (!after && afterGeometryLength > 0) {
      after = [[point.x, point.y], [toPoint.x, toPoint.y]];
    }
    if (before) {
      before[0] = [fromPoint.x, fromPoint.y];
      before[before.length - 1] = [point.x, point.y];
    }
    if (after) {
      after[0] = [point.x, point.y];
      after[after.length - 1] = [toPoint.x, toPoint.y];
    }
    if (before && beforeLength > 0) {
      this.#addEdge(from, nodeId, partial(before, beforeLength));
      if (!oneWay) {
        this.#addEdge(nodeId, from, partial(before.slice().reverse(), beforeLength));
      }
    }
    if (after && afterLength > 0) {
      this.#addEdge(nodeId, to, partial(after, afterLength));
      if (!oneWay) {
        this.#addEdge(to, nodeId, partial(after.slice().reverse(), afterLength));
      }
    }
    this.#components.union(nodeId, from);

    const siblings = this.#splitNodesBySegment.get(segment.id) ?? [];
    for (const sibling of siblings) {
      this.#countCandidateEvaluation();
      let locationOrder = sibling.index < projection.index
        ? -1
        : sibling.index > projection.index
          ? 1
          : 0;
      const hasExactOrder = (
        locationOrder === 0
        && sibling.orderNumerator
        && orderNumerator
      );
      if (hasExactOrder) {
        locationOrder = compareDyadicTokens(
          sibling.orderNumerator,
          orderNumerator,
        );
      } else if (locationOrder === 0) {
        locationOrder = sibling.distanceAlong < projection.distanceAlong
          ? -1
          : sibling.distanceAlong > projection.distanceAlong
            ? 1
            : 0;
      }
      if (!hasExactOrder && locationOrder === 0) {
        locationOrder = sibling.distanceToEnd > afterGeometryLength
          ? -1
          : sibling.distanceToEnd < afterGeometryLength
            ? 1
            : 0;
      }
      if (!hasExactOrder && locationOrder === 0) {
        locationOrder = sibling.t < projection.t
          ? -1
          : sibling.t > projection.t
            ? 1
            : 0;
      }
      if (!hasExactOrder && locationOrder === 0) {
        const segmentStart = segment.coordinates[projection.index];
        const segmentEnd = segment.coordinates[projection.index + 1];
        const axis = Math.abs(segmentEnd[0] - segmentStart[0])
          >= Math.abs(segmentEnd[1] - segmentStart[1])
          ? 0
          : 1;
        const siblingCoordinate = axis === 0
          ? sibling.x
          : sibling.y;
        const projectionCoordinate = axis === 0 ? point.x : point.y;
        const axisOrder = siblingCoordinate < projectionCoordinate
          ? -1
          : siblingCoordinate > projectionCoordinate
            ? 1
            : 0;
        locationOrder = segmentEnd[axis] >= segmentStart[axis]
          ? axisOrder
          : -axisOrder;
      }
      if (locationOrder === 0) continue;
      let coordinates = sliceLineByDistance(
        segment.coordinates,
        sibling.distanceAlong,
        projection.distanceAlong,
      );
      let partialLength = Math.abs(
        sibling.lengthAlong - beforeLength,
      );
      const siblingPoint = this.#nodePositions.get(sibling.nodeId);
      if (!coordinates) {
        coordinates = [
          [siblingPoint.x, siblingPoint.y],
          [point.x, point.y],
        ];
      }
      if (partialLength === 0) partialLength = Number.MIN_VALUE;
      coordinates[0] = [siblingPoint.x, siblingPoint.y];
      coordinates[coordinates.length - 1] = [point.x, point.y];
      const siblingBefore = locationOrder < 0;
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
    siblings.push({
      distanceAlong: projection.distanceAlong,
      distanceToEnd: afterGeometryLength,
      index: projection.index,
      lengthAlong: beforeLength,
      nodeId,
      orderNumerator,
      t: projection.t,
      x: point.x,
      y: point.y,
    });
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
      () => this.#countCandidateEvaluation(),
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
      const edge = this.#gapEdge(
        nodeId,
        target.nodeId,
        "anchor-snap",
        projection.distance,
      );
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
      if (!point || !goal) return 0;
      const estimate = distance(point, goal) * minimumCostPerDistance;
      return Number.isFinite(estimate) ? estimate : 0;
    };
    const scores = new Map([[startId, 0]]);
    const previous = new Map();
    const visited = new Set();
    const queue = new MinHeap();
    queue.push({ key: heuristic(startId), nodeId: startId });

    while (queue.size > 0) {
      const current = queue.pop();
      if (visited.has(current.nodeId)) continue;
      this.#countSearchExpansion();
      visited.add(current.nodeId);
      if (current.nodeId === goalId) break;
      const currentScore = scores.get(current.nodeId);
      for (
        const { to, edge }
        of this.#adjacency.get(current.nodeId) ?? []
      ) {
        if (visited.has(to)) continue;
        const candidate = currentScore + edge.cost;
        if (!Number.isFinite(candidate)) {
          throw new TypeError("route cost must remain finite");
        }
        if (!scores.has(to) || candidate < scores.get(to)) {
          scores.set(to, candidate);
          previous.set(to, { nodeId: current.nodeId, edge });
          const priority = candidate + heuristic(to);
          if (!Number.isFinite(priority)) {
            throw new TypeError("route cost must remain finite");
          }
          queue.push({ key: priority, nodeId: to });
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
      this.#countSearchExpansion();
      for (const { to, edge } of reverse.get(current.nodeId) ?? []) {
        const candidate = current.key + edge.cost;
        if (!Number.isFinite(candidate)) {
          throw new TypeError("route cost must remain finite");
        }
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
      this.#countFallbackPairEvaluation();
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
      candidateEvaluations: this.#candidateEvaluations,
      searchExpansions: this.#searchExpansions,
      fallbackPairEvaluations: this.#fallbackPairEvaluations,
      stats: { ...this.#stats },
    };
  }

  #restoreQueryState(snapshot) {
    this.#adjacency = snapshot.adjacency;
    this.#nodePositions = snapshot.nodePositions;
    this.#components.parent = snapshot.componentParents;
    this.#splitNodesBySegment = snapshot.splitNodesBySegment;
    this.#nextVirtualNumber = snapshot.nextVirtualNumber;
    this.#candidateEvaluations = snapshot.candidateEvaluations;
    this.#searchExpansions = snapshot.searchExpansions;
    this.#fallbackPairEvaluations = snapshot.fallbackPairEvaluations;
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
        throw new TypeError("unknown route option");
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
    this.#candidateEvaluations = 0;
    this.#searchExpansions = 0;
    this.#fallbackPairEvaluations = 0;
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
          (leg) => leg.length > 0 || leg.cost > 0,
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
            || coordinateDistance(coordinates.at(-1), coordinate) > 0
          ) {
            coordinates.push([coordinate[0], coordinate[1]]);
          }
        }
      }
      let routeDistance = 0;
      let routeCost = 0;
      for (const leg of legs) {
        routeDistance += leg.length;
        routeCost += leg.cost;
        if (!Number.isFinite(routeDistance)) {
          throw new TypeError("route distance must remain finite");
        }
        if (!Number.isFinite(routeCost)) {
          throw new TypeError("route cost must remain finite");
        }
      }
      return {
        ok: true,
        coordinates,
        legs,
        distance: routeDistance,
        cost: routeCost,
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
