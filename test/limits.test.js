import assert from "node:assert/strict";
import test from "node:test";

import {
  GapRouter,
  RouterLimitError,
} from "../src/index.js";

const lineInput = () => ({
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 10, y: 0 },
  ],
  segments: [{
    id: "line",
    from: "a",
    to: "b",
    coordinates: [[0, 0], [10, 0]],
  }],
  options: { maxGapDistance: 0, mergeTolerance: 0 },
});

const captureLimitError = (run) => {
  let captured;
  assert.throws(run, (error) => {
    captured = error;
    return error instanceof RouterLimitError;
  });
  return captured;
};

test("validates bounded execution profiles", () => {
  for (const limits of [null, [], "limits"]) {
    assert.throws(
      () => new GapRouter({ nodes: [], segments: [], limits }),
      /limits must be an object/,
    );
  }
  for (const value of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new GapRouter({
        nodes: [],
        segments: [],
        limits: { maxNodes: value },
      }),
      /maxNodes must be a non-negative safe integer/,
    );
  }
  assert.throws(
    () => new GapRouter({
      nodes: [],
      segments: [],
      limits: { maxUnknownWork: 1 },
    }),
    /unknown router limit/,
  );
  assert.doesNotThrow(() => new GapRouter({
    nodes: [],
    segments: [],
    limits: { maxNodes: undefined },
  }));

  const oversizedUnknownField = `private-${"x".repeat(100_000)}`;
  assert.throws(
    () => new GapRouter({
      nodes: [],
      segments: [],
      limits: { [oversizedUnknownField]: 1 },
    }),
    (error) => (
      error instanceof TypeError
      && error.message === "unknown router limit"
      && !error.message.includes(oversizedUnknownField)
    ),
  );
});

test("enforces input cardinality limits at and above their boundaries", () => {
  assert.doesNotThrow(() => new GapRouter({
    ...lineInput(),
    limits: {
      maxNodes: 2,
      maxSegments: 1,
      maxCoordinates: 2,
    },
  }));

  for (const [name, limit, code, actual] of [
    ["maxNodes", 1, "MAX_NODES", 2],
    ["maxSegments", 0, "MAX_SEGMENTS", 1],
    ["maxCoordinates", 1, "MAX_COORDINATES", 2],
  ]) {
    const error = captureLimitError(() => new GapRouter({
      ...lineInput(),
      limits: { [name]: limit },
    }));
    assert.equal(error.name, "RouterLimitError");
    assert.ok(error instanceof RangeError);
    assert.equal(error.code, code);
    assert.equal(error.phase, "input");
    assert.equal(error.limit, limit);
    assert.equal(error.actual, actual);
  }
});

test("keeps limit errors free of caller ids, coordinates, and metadata", () => {
  const marker = "private-customer-marker";
  const error = captureLimitError(() => new GapRouter({
    nodes: [{
      id: marker,
      x: 123_456,
      y: 654_321,
      metadata: marker,
    }],
    segments: [],
    limits: { maxNodes: 0 },
  }));

  assert.equal(error.message.includes(marker), false);
  assert.equal(error.message.includes("123456"), false);
  assert.equal(error.message, "router execution limit exceeded: MAX_NODES");
});

test("bounds aggregate spatial samples across individually safe segments", () => {
  const input = {
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 1, y: 0 },
      { id: "c", x: 2, y: 0 },
    ],
    segments: [
      {
        id: "ab",
        from: "a",
        to: "b",
        coordinates: [[0, 0], [1, 0]],
      },
      {
        id: "bc",
        from: "b",
        to: "c",
        coordinates: [[1, 0], [2, 0]],
      },
    ],
    options: {
      maxGapDistance: 0,
      mergeTolerance: 0,
      segmentSampleStep: 1,
    },
  };

  assert.doesNotThrow(() => new GapRouter({
    ...input,
    limits: { maxSpatialSamplesTotal: 4 },
  }));
  const error = captureLimitError(() => new GapRouter({
    ...input,
    limits: { maxSpatialSamplesTotal: 3 },
  }));
  assert.deepEqual(
    {
      code: error.code,
      phase: error.phase,
      limit: error.limit,
      actual: error.actual,
    },
    {
      code: "MAX_SPATIAL_SAMPLES_TOTAL",
      phase: "spatial-index",
      limit: 3,
      actual: 4,
    },
  );
});

test("applies aggregate sample limits before per-segment guards", () => {
  const marker = "private-segment-id";
  const error = captureLimitError(() => new GapRouter({
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 2_000_000, y: 0 },
    ],
    segments: [{
      id: marker,
      from: "a",
      to: "b",
      coordinates: [[0, 0], [2_000_000, 0]],
    }],
    options: {
      maxGapDistance: 0,
      mergeTolerance: 0,
      segmentSampleStep: 1,
    },
    limits: { maxSpatialSamplesTotal: 1 },
  }));

  assert.equal(error.code, "MAX_SPATIAL_SAMPLES_TOTAL");
  assert.equal(error.phase, "spatial-index");
  assert.equal(error.message.includes(marker), false);
});

test("bounds dense candidate generation deterministically", () => {
  const error = captureLimitError(() => new GapRouter({
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 1, y: 0 },
      { id: "c", x: 2, y: 0 },
      { id: "d", x: 3, y: 0 },
    ],
    segments: [
      {
        id: "ab",
        from: "a",
        to: "b",
        coordinates: [[0, 0], [1, 0]],
      },
      {
        id: "cd",
        from: "c",
        to: "d",
        coordinates: [[2, 0], [3, 0]],
      },
    ],
    options: { maxGapDistance: 5, mergeTolerance: 0 },
    limits: { maxCandidateEvaluations: 0 },
  }));

  assert.equal(error.code, "MAX_CANDIDATE_EVALUATIONS");
  assert.equal(error.phase, "candidate-generation");
  assert.equal(error.actual, 1);
});

test("counts spatial bucket entries rejected by the query radius", () => {
  const error = captureLimitError(() => new GapRouter({
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 0.5, y: 0 },
    ],
    segments: [{
      id: "ab",
      from: "a",
      to: "b",
      coordinates: [[0, 0], [0.5, 0]],
    }],
    options: { maxGapDistance: 0, mergeTolerance: 0 },
    limits: { maxCandidateEvaluations: 0 },
  }));

  assert.equal(error.code, "MAX_CANDIDATE_EVALUATIONS");
  assert.equal(error.phase, "candidate-generation");
  assert.equal(error.actual, 1);
});

test("counts every member comparison in merged endpoint clusters", () => {
  const nodes = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 0.1, y: 0 },
    { id: "c", x: 0.2, y: 0 },
  ];
  const segments = nodes.map((node) => ({
    id: `loop-${node.id}`,
    from: node.id,
    to: node.id,
    coordinates: [
      [node.x, 0],
      [node.x, 1],
      [node.x, 0],
    ],
  }));
  const error = captureLimitError(() => new GapRouter({
    nodes,
    segments,
    options: { maxGapDistance: 0, mergeTolerance: 1 },
    limits: { maxCandidateEvaluations: 4 },
  }));

  assert.equal(error.code, "MAX_CANDIDATE_EVALUATIONS");
  assert.equal(error.actual, 5);
});

test("bounds sibling edges created by repeated segment projections", () => {
  const projectionCount = 20;
  const nodes = [
    { id: "target-a", x: 0, y: 0 },
    { id: "target-b", x: (projectionCount + 1) * 4, y: 0 },
  ];
  const segments = [{
    id: "target",
    from: "target-a",
    to: "target-b",
    coordinates: [[0, 0], [(projectionCount + 1) * 4, 0]],
  }];
  for (let index = 1; index <= projectionCount; index += 1) {
    const x = index * 4;
    nodes.push(
      { id: `top-${index}`, x, y: 2 },
      { id: `tip-${index}`, x, y: 0.5 },
    );
    segments.push({
      id: `source-${index}`,
      from: `top-${index}`,
      to: `tip-${index}`,
      coordinates: [[x, 2], [x, 0.5]],
    });
  }

  const error = captureLimitError(() => new GapRouter({
    nodes,
    segments,
    options: {
      gapConnectorsPerNode: 0,
      maxGapDistance: 1,
      mergeTolerance: 0,
      projectionMinGain: 0,
      segmentSampleStep: 4,
    },
    limits: {
      maxCandidateEvaluations: 700,
      maxCoordinates: 100,
      maxNodes: 100,
      maxSegments: 100,
      maxSpatialSamplesTotal: 100,
    },
  }));

  assert.equal(error.code, "MAX_CANDIDATE_EVALUATIONS");
  assert.equal(error.phase, "candidate-generation");
  assert.equal(error.actual, 701);
});

test("resets route candidate budgets for every query", () => {
  const router = new GapRouter({
    ...lineInput(),
    limits: { maxCandidateEvaluations: 4 },
  });
  const options = { anchorCandidateCount: 1, maxSnapDistance: 0 };
  const first = router.route({ x: 0, y: 0 }, { x: 10, y: 0 }, options);
  const second = router.route({ x: 0, y: 0 }, { x: 10, y: 0 }, options);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);

  const constrained = new GapRouter({
    ...lineInput(),
    limits: { maxCandidateEvaluations: 3 },
  });
  const error = captureLimitError(() => constrained.route(
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    options,
  ));
  assert.equal(error.code, "MAX_CANDIDATE_EVALUATIONS");
  assert.equal(error.actual, 4);
});

test("bounds search expansions and restores query state after errors", () => {
  const router = new GapRouter({
    ...lineInput(),
    limits: { maxSearchExpansions: 1 },
  });
  const route = () => router.route(
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { anchorCandidateCount: 1, maxSnapDistance: 0 },
  );

  const first = captureLimitError(route);
  const second = captureLimitError(route);
  assert.equal(first.code, "MAX_SEARCH_EXPANSIONS");
  assert.deepEqual(
    [second.code, second.phase, second.limit, second.actual],
    [first.code, first.phase, first.limit, first.actual],
  );

  const samePoint = router.route(
    { x: 5, y: 0 },
    { x: 5, y: 0 },
    { anchorCandidateCount: 1, maxSnapDistance: 0 },
  );
  assert.equal(samePoint.ok, true);
  assert.equal(samePoint.distance, 0);
});

test("bounds fallback pair evaluation separately from graph search", () => {
  const router = new GapRouter({
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 10, y: 0 },
      { id: "c", x: 20, y: 0 },
      { id: "d", x: 30, y: 0 },
    ],
    segments: [
      {
        id: "left",
        from: "a",
        to: "b",
        coordinates: [[0, 0], [10, 0]],
      },
      {
        id: "right",
        from: "c",
        to: "d",
        coordinates: [[20, 0], [30, 0]],
      },
    ],
    options: { maxGapDistance: 0, mergeTolerance: 0 },
    limits: { maxFallbackPairEvaluations: 0 },
  });

  const error = captureLimitError(() => router.route(
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    {
      anchorCandidateCount: 1,
      maxFallbackBridgeDistance: 20,
      maxFallbackBridges: 1,
      maxSnapDistance: 0,
    },
  ));
  assert.equal(error.code, "MAX_FALLBACK_PAIR_EVALUATIONS");
  assert.equal(error.phase, "fallback");
  assert.equal(error.actual, 1);
});

test("preserves legacy route results under a high bounded profile", () => {
  const input = lineInput();
  const unlimited = new GapRouter(input).route(
    { x: 1, y: 0 },
    { x: 9, y: 0 },
    { anchorCandidateCount: 1, maxSnapDistance: 0 },
  );
  const bounded = new GapRouter({
    ...input,
    limits: {
      maxCandidateEvaluations: 100,
      maxCoordinates: 100,
      maxFallbackPairEvaluations: 100,
      maxNodes: 100,
      maxSearchExpansions: 100,
      maxSegments: 100,
      maxSpatialSamplesTotal: 100,
    },
  }).route(
    { x: 1, y: 0 },
    { x: 9, y: 0 },
    { anchorCandidateCount: 1, maxSnapDistance: 0 },
  );
  assert.deepEqual(bounded, unlimited);
});
