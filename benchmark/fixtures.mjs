const ROUTER_FIXTURE_SEED = "synthetic-planar-set-v1";

const routerOptions = Object.freeze({
  mergeTolerance: 1,
  endpointTolerance: 1,
  maxGapDistance: 5,
  gapConnectorsPerNode: 2,
  gapFixedCost: 3,
  gapCostFactor: 1.4,
  gapSpeed: 2.5,
  projectionMinGain: 1.5,
  segmentSampleStep: 8,
  respectOneWay: true,
  maxFallbackBridges: 0,
  maxFallbackBridgeDistance: 25,
});

const seedHash = (text) => {
  let value = 2_166_136_261;
  for (const character of text) {
    value ^= character.codePointAt(0);
    value = Math.imul(value, 16_777_619);
  }
  return value >>> 0;
};

const createRandom = (seed) => {
  let state = seedHash(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
};

const integerBetween = (random, minimum, maximum) => (
  minimum + Math.floor(random() * (maximum - minimum + 1))
);

const roundCoordinate = (value) => Math.round(value * 1_000) / 1_000;

class RouterNetworkBuilder {
  #nodes = [];
  #segments = [];
  #nodeById = new Map();

  addNode(x, y) {
    const id = `N${String(this.#nodes.length + 1).padStart(3, "0")}`;
    const node = { id, x: roundCoordinate(x), y: roundCoordinate(y) };
    this.#nodes.push(node);
    this.#nodeById.set(id, node);
    return id;
  }

  point(id) {
    const point = this.#nodeById.get(id);
    if (!point) throw new Error(`unknown fixture node: ${id}`);
    return point;
  }

  addSegment(from, to, extra = {}) {
    const fromPoint = this.point(from);
    const toPoint = this.point(to);
    const segment = {
      id: `S${String(this.#segments.length + 1).padStart(3, "0")}`,
      from,
      to,
      coordinates: extra.coordinates ?? [
        [fromPoint.x, fromPoint.y],
        [toPoint.x, toPoint.y],
      ],
      speed: extra.speed ?? 8,
    };
    if (extra.oneWay === true) segment.oneWay = true;
    this.#segments.push(segment);
  }

  output() {
    return {
      nodes: this.#nodes,
      segments: this.#segments,
      options: { ...routerOptions },
    };
  }
}

const addGridModule = (builder, baseX, baseY) => {
  const nodes = [];
  for (let row = 0; row < 4; row += 1) {
    const current = [];
    for (let column = 0; column < 4; column += 1) {
      current.push(builder.addNode(baseX + column * 12, baseY + row * 12));
    }
    nodes.push(current);
  }
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      builder.addSegment(nodes[row][column], nodes[row][column + 1]);
    }
  }
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      builder.addSegment(nodes[row][column], nodes[row + 1][column]);
    }
  }
};

const addMergeModule = (builder, baseX, baseY, imperfect) => {
  const left = [0, 12, 24, 36]
    .map((offset) => builder.addNode(baseX + offset, baseY));
  const rightStart = imperfect
    ? builder.addNode(baseX + 36.65, baseY + 0.35)
    : left.at(-1);
  const right = [48, 60, 72, 84]
    .map((offset) => builder.addNode(baseX + offset, baseY));

  for (let index = 0; index < left.length - 1; index += 1) {
    builder.addSegment(left[index], left[index + 1]);
  }
  builder.addSegment(rightStart, right[0]);
  for (let index = 0; index < right.length - 1; index += 1) {
    builder.addSegment(right[index], right[index + 1]);
  }
};

const addGapModule = (builder, baseX, baseY, imperfect) => {
  const offsets = imperfect
    ? [0, 12, 24, 36, 40, 60, 72, 84]
    : [0, 12, 24, 36, 48, 60, 72, 84];
  const nodes = offsets.map((offset) => builder.addNode(baseX + offset, baseY));
  for (let index = 0; index < nodes.length - 1; index += 1) {
    if (!(imperfect && index === 3)) {
      builder.addSegment(nodes[index], nodes[index + 1]);
    }
  }
};

const addJunctionModule = (builder, baseX, baseY, imperfect) => {
  if (!imperfect) {
    const bar = [0, 12, 24, 36, 48]
      .map((offset) => builder.addNode(baseX + offset, baseY + 18));
    const stem = [-18, -6, 6]
      .map((offset) => builder.addNode(baseX + 24, baseY + offset));
    for (let index = 0; index < bar.length - 1; index += 1) {
      builder.addSegment(bar[index], bar[index + 1]);
    }
    builder.addSegment(stem[0], stem[1]);
    builder.addSegment(stem[1], stem[2]);
    builder.addSegment(stem[2], bar[2]);
    return;
  }

  const bar = [0, 12, 36, 48]
    .map((offset) => builder.addNode(baseX + offset, baseY + 18));
  const stem = [-18, -6, 6, 15]
    .map((offset) => builder.addNode(baseX + 24, baseY + offset));
  for (let index = 0; index < bar.length - 1; index += 1) {
    builder.addSegment(bar[index], bar[index + 1]);
  }
  for (let index = 0; index < stem.length - 1; index += 1) {
    builder.addSegment(stem[index], stem[index + 1]);
  }
};

const addCurvedModule = (builder, baseX, baseY, random) => {
  const nodes = [];
  let y = baseY + integerBetween(random, -3, 3);
  for (let index = 0; index < 8; index += 1) {
    if (index > 0) y += integerBetween(random, -3, 3);
    nodes.push(builder.addNode(baseX + index * 12, y));
  }
  for (let index = 0; index < nodes.length - 1; index += 1) {
    builder.addSegment(nodes[index], nodes[index + 1]);
  }
  return nodes.map((id) => builder.point(id));
};

const addDirectedModule = (builder, baseX, baseY) => {
  const nodes = Array.from(
    { length: 7 },
    (_, index) => builder.addNode(baseX + index * 12, baseY),
  );
  for (let index = 0; index < nodes.length - 1; index += 1) {
    builder.addSegment(nodes[index], nodes[index + 1], { oneWay: true });
  }
};

const addSquare = (builder, baseX, baseY) => {
  const nodes = [
    builder.addNode(baseX, baseY),
    builder.addNode(baseX + 12, baseY),
    builder.addNode(baseX + 12, baseY + 12),
    builder.addNode(baseX, baseY + 12),
  ];
  builder.addSegment(nodes[0], nodes[1]);
  builder.addSegment(nodes[1], nodes[2]);
  builder.addSegment(nodes[2], nodes[3]);
  builder.addSegment(nodes[3], nodes[0]);
};

const addSeparatedSquares = (builder, baseX, baseY) => {
  addSquare(builder, baseX, baseY);
  addSquare(builder, baseX + 42, baseY);
};

const addFallbackModule = (builder, baseX, baseY, imperfect) => {
  const left = [0, 10, 20, 30, 40]
    .map((offset) => builder.addNode(baseX + offset, baseY));
  const right = [60, 70, 80, 90, 100]
    .map((offset) => builder.addNode(baseX + offset, baseY));
  for (let index = 0; index < left.length - 1; index += 1) {
    builder.addSegment(left[index], left[index + 1]);
    builder.addSegment(right[index], right[index + 1]);
  }
  if (!imperfect) builder.addSegment(left.at(-1), right[0]);
};

const offsetPoint = (a, b, ratio, offset) => {
  const x = a.x + (b.x - a.x) * ratio;
  const y = a.y + (b.y - a.y) * ratio;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  return {
    x: roundCoordinate(x - ((b.y - a.y) / length) * offset),
    y: roundCoordinate(y + ((b.x - a.x) / length) * offset),
  };
};

const buildReferenceNetwork = (imperfect) => {
  const builder = new RouterNetworkBuilder();
  const random = createRandom(`${ROUTER_FIXTURE_SEED}:curve`);
  addGridModule(builder, 0, 0);
  addMergeModule(builder, 120, 0, imperfect);
  addGapModule(builder, 240, 0, imperfect);
  addJunctionModule(builder, 360, 0, imperfect);
  const curve = addCurvedModule(builder, 0, 120, random);
  addDirectedModule(builder, 120, 120);
  addSeparatedSquares(builder, 240, 120);
  addFallbackModule(builder, 360, 120, imperfect);
  return { network: builder.output(), curve };
};

const referenceCases = (curve) => [
  {
    id: "case-001",
    label: "Ordinary route",
    network: "clean",
    start: { x: 1.5, y: 1 },
    goal: { x: 34.5, y: 35 },
    options: { maxSnapDistance: 3, anchorCandidateCount: 1 },
    expected: { ok: true, distance: 71, gapReasons: ["anchor-snap"] },
  },
  {
    id: "case-002",
    label: "Endpoint merge",
    network: "imperfect",
    start: { x: 121, y: 0 },
    goal: { x: 203, y: 0 },
    options: { maxSnapDistance: 2, anchorCandidateCount: 1 },
    expected: {
      ok: true,
      distance: 81.3553951934752,
      gapReasons: [],
      mergedNodesAtLeast: 1,
    },
  },
  {
    id: "case-003",
    label: "Short component gap",
    network: "imperfect",
    start: { x: 241, y: 0 },
    goal: { x: 323, y: 0 },
    options: { maxSnapDistance: 2, anchorCandidateCount: 1 },
    expected: {
      ok: true,
      distance: 82,
      gapReasons: ["nearby-components"],
    },
  },
  {
    id: "case-004",
    label: "Undershot junction",
    network: "imperfect",
    start: { x: 384, y: -17 },
    goal: { x: 406, y: 18 },
    options: { maxSnapDistance: 2, anchorCandidateCount: 1 },
    expected: {
      ok: true,
      distance: 57,
      gapReasons: ["dead-end-projection"],
    },
  },
  {
    id: "case-005",
    label: "Off-network points",
    network: "imperfect",
    start: offsetPoint(curve[1], curve[2], 0.45, 2.75),
    goal: offsetPoint(curve[5], curve[6], 0.55, -2.25),
    options: { maxSnapDistance: 4, anchorCandidateCount: 1 },
    expected: {
      ok: true,
      distance: 55.2182530763301,
      gapReasons: ["anchor-snap"],
    },
  },
  {
    id: "case-006",
    label: "One-way rejection",
    network: "imperfect",
    start: { x: 191, y: 120 },
    goal: { x: 121, y: 120 },
    options: { maxSnapDistance: 1, anchorCandidateCount: 1 },
    expected: { ok: false, reason: "no-route" },
  },
  {
    id: "case-007",
    label: "Disconnected components",
    network: "imperfect",
    start: { x: 241, y: 121 },
    goal: { x: 293, y: 131 },
    options: { maxSnapDistance: 2, anchorCandidateCount: 1 },
    expected: { ok: false, reason: "no-route" },
  },
  {
    id: "case-008",
    label: "Opt-in fallback",
    network: "imperfect",
    start: { x: 361, y: 120 },
    goal: { x: 459, y: 120 },
    options: {
      maxSnapDistance: 1,
      anchorCandidateCount: 1,
      maxFallbackBridges: 1,
      maxFallbackBridgeDistance: 25,
    },
    expected: {
      ok: true,
      distance: 98,
      gapReasons: ["fallback-bridge"],
    },
  },
];

export const createRouterReferenceFixture = () => {
  const clean = buildReferenceNetwork(false);
  const imperfect = buildReferenceNetwork(true);
  return {
    seed: ROUTER_FIXTURE_SEED,
    networks: { clean: clean.network, imperfect: imperfect.network },
    cases: referenceCases(imperfect.curve),
  };
};

export const createRouterGridFixture = (nodeCount) => {
  const side = Math.sqrt(nodeCount);
  if (!Number.isSafeInteger(side) || side < 2) {
    throw new TypeError("router grid size must be a square integer of at least 4");
  }
  const nodes = [];
  const segments = [];
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const id = `${x}:${y}`;
      nodes.push({ id, x: x * 10, y: y * 10 });
      if (x > 0) {
        segments.push({
          id: `h:${x - 1}:${y}`,
          from: `${x - 1}:${y}`,
          to: id,
          coordinates: [[(x - 1) * 10, y * 10], [x * 10, y * 10]],
          speed: 2,
        });
      }
      if (y > 0) {
        segments.push({
          id: `v:${x}:${y - 1}`,
          from: `${x}:${y - 1}`,
          to: id,
          coordinates: [[x * 10, (y - 1) * 10], [x * 10, y * 10]],
          speed: 2,
        });
      }
    }
  }
  return {
    input: {
      nodes,
      segments,
      options: { maxGapDistance: 0, mergeTolerance: 0 },
    },
    start: { x: 0, y: 0 },
    goal: { x: (side - 1) * 10, y: (side - 1) * 10 },
    routeOptions: { anchorCandidateCount: 1, maxSnapDistance: 0 },
    expectedDistance: (side - 1) * 20,
  };
};

const enginePosition = (index, dimensions, spacing = 10) => (
  dimensions === 2
    ? [index * spacing, (index % 7) * spacing]
    : [index * spacing, (index % 7) * spacing, (index % 11) * spacing]
);

export const createSparseEngineInput = (dimensions, nodeCount) => ({
  snapshot: {
    schema: "gtr.network/v1",
    networkId: `benchmark-sparse-${dimensions}d`,
    revision: `nodes-${nodeCount}`,
    space: { dimensions, unit: "u", frame: "synthetic" },
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      id: `node-${index}`,
      position: enginePosition(index, dimensions),
    })),
    edges: [],
  },
  proposal: { includeEndpointToEdge: false, maxGapDistance: 0.25 },
});

export const createProjectionEngineInput = (probeCount) => {
  const geometry = Array.from(
    { length: probeCount + 1 },
    (_, index) => [index, 0],
  );
  return {
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "benchmark-projection-2d",
      revision: `probes-${probeCount}`,
      space: { dimensions: 2, unit: "u", frame: "synthetic" },
      nodes: [
        { id: "line-start", position: geometry[0] },
        { id: "line-end", position: geometry.at(-1) },
        ...Array.from({ length: probeCount }, (_, index) => ({
          id: `probe-${index}`,
          position: [index + 0.5, 0.25],
        })),
      ],
      edges: [{
        id: "line",
        from: "line-start",
        to: "line-end",
        geometry,
      }],
    },
    proposal: {
      maxGapDistance: 0.5,
      maxCandidatesPerEndpoint: 1,
    },
  };
};

export const createConstrainedEngineInput = (moduleCount) => {
  const nodes = [];
  const edges = [];
  const forbiddenNodePairs = [];
  for (let index = 0; index < moduleCount; index += 1) {
    const baseY = index * 10;
    const ids = {
      source: `m${index}-source`,
      left: `m${index}-left`,
      right: `m${index}-right`,
      target: `m${index}-target`,
    };
    nodes.push(
      { id: ids.source, position: [0, baseY, 0] },
      { id: ids.left, position: [2, baseY, 0] },
      { id: ids.right, position: [2.5, baseY, 0] },
      { id: ids.target, position: [4.5, baseY, 0] },
    );
    edges.push(
      {
        id: `m${index}-a`,
        from: ids.source,
        to: ids.left,
        geometry: [[0, baseY, 0], [2, baseY, 0]],
      },
      {
        id: `m${index}-b`,
        from: ids.right,
        to: ids.target,
        geometry: [[2.5, baseY, 0], [4.5, baseY, 0]],
      },
    );
    if (index % 2 === 0) forbiddenNodePairs.push([ids.left, ids.right]);
  }
  return {
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "benchmark-constraints-3d",
      revision: `modules-${moduleCount}`,
      space: { dimensions: 3, unit: "u", frame: "synthetic" },
      nodes,
      edges,
    },
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 1,
      maxCandidatesPerEndpoint: 2,
      requireDifferentComponents: true,
      requireTangentEvidence: true,
    },
    constraints: { forbiddenNodePairs },
  };
};

export const createDenseEngineInput = (
  nodeCount,
  { useDefaultLimits = false } = {},
) => {
  const input = {
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "benchmark-dense-2d",
      revision: `nodes-${nodeCount}`,
      space: { dimensions: 2, unit: "u", frame: "synthetic" },
      nodes: Array.from({ length: nodeCount }, (_, index) => ({
        id: `node-${index}`,
        position: [(index % 32) * 0.01, Math.floor(index / 32) * 0.01],
      })),
      edges: [],
    },
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 1,
      maxCandidatesPerEndpoint: 2,
    },
  };
  if (!useDefaultLimits) {
    input.limits = {
      maxNeighborChecks: nodeCount * nodeCount * 2,
      maxCandidatesTotal: nodeCount * nodeCount,
    };
  }
  return input;
};
