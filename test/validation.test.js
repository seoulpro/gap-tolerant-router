import assert from "node:assert/strict";
import test from "node:test";

import {
  GapRouter,
  lineLength,
  projectPointToLine,
} from "../src/index.js";

test("validates exported geometry helpers", () => {
  assert.equal(lineLength([]), 0);
  assert.equal(lineLength([[0, 0], [3, 4]]), 5);
  assert.equal(projectPointToLine({ x: 0, y: 0 }, [[0, 0]]), null);

  assert.throws(() => lineLength(null), /must be an array/);
  assert.throws(
    () => lineLength([[0, 0], [Infinity, 1]]),
    /finite numeric pairs/,
  );
  assert.throws(
    () => projectPointToLine(null, [[0, 0], [1, 1]]),
    /finite numeric x and y/,
  );
  assert.throws(
    () => projectPointToLine(
      { x: 0, y: 0 },
      [[0, 0], ["1", 1]],
    ),
    /finite numeric pairs/,
  );
});

test("rejects segment geometry that does not meet its endpoint nodes", () => {
  assert.throws(
    () => new GapRouter({
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 10, y: 0 },
      ],
      segments: [{
        id: "line",
        from: "a",
        to: "b",
        coordinates: [[3, 0], [10, 0]],
      }],
      options: { endpointTolerance: 1, mergeTolerance: 0 },
    }),
    /geometry endpoints must be within endpointTolerance/,
  );
});

test("allows bounded endpoint mismatch and normalizes the route", () => {
  const router = new GapRouter({
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 10, y: 0 },
    ],
    segments: [{
      id: "line",
      from: "a",
      to: "b",
      coordinates: [[0.25, 0], [9.75, 0]],
      speed: 1,
    }],
    options: {
      endpointTolerance: 0.5,
      maxGapDistance: 0,
      mergeTolerance: 0,
    },
  });

  const result = router.route(
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { maxSnapDistance: 0 },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.coordinates, [[0, 0], [10, 0]]);
  assert.equal(result.distance, 9.5);
});

test("copies routing input before building indexes", () => {
  const nodes = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 10, y: 0 },
  ];
  const coordinates = [[0, 0], [10, 0]];
  const options = {
    maxGapDistance: 0,
    mergeTolerance: 0,
  };
  const router = new GapRouter({
    nodes,
    segments: [{
      id: "line",
      from: "a",
      to: "b",
      coordinates,
      speed: 1,
    }],
    options,
  });

  nodes[0].x = 1_000;
  coordinates[0][0] = 1_000;
  options.maxGapDistance = 1_000;

  const result = router.route(
    { x: 1, y: 0 },
    { x: 9, y: 0 },
    { maxSnapDistance: 0 },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.coordinates, [[1, 0], [9, 0]]);
  assert.equal(result.distance, 8);
});

test("fails fast when a segment would require an unsafe sample count", () => {
  assert.throws(
    () => new GapRouter({
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 1_000_000_000, y: 0 },
      ],
      segments: [{
        id: "line",
        from: "a",
        to: "b",
        coordinates: [[0, 0], [1_000_000_000, 0]],
      }],
      options: {
        maxGapDistance: 0,
        mergeTolerance: 0,
        segmentSampleStep: 0.001,
      },
    }),
    /requires too many spatial samples/,
  );
});

test("handles a huge snap radius without iterating an empty cell rectangle", () => {
  const router = new GapRouter({
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

  const result = router.route(
    { x: 1, y: 1 },
    { x: 9, y: -1 },
    { maxSnapDistance: Number.MAX_VALUE },
  );
  assert.equal(result.ok, true);
});

test("keeps the default snap radius finite when the gap radius is huge", () => {
  const router = new GapRouter({
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
    options: {
      maxGapDistance: Number.MAX_VALUE,
      mergeTolerance: 0,
    },
  });

  const result = router.route(
    { x: 1, y: 0 },
    { x: 9, y: 0 },
  );
  assert.equal(result.ok, true);
});

test("restores query state after failed searches and validation errors", () => {
  const router = new GapRouter({
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

  assert.deepEqual(
    router.route(
      { x: 100, y: 0 },
      { x: 9, y: 0 },
      { maxSnapDistance: 1 },
    ),
    { ok: false, reason: "start-not-near-network" },
  );
  assert.throws(
    () => router.route(
      { x: 1, y: 0 },
      { x: 9, y: 0 },
      { maxFallbackBridges: 0.5 },
    ),
    /non-negative integer/,
  );

  const result = router.route(
    { x: 1, y: 0 },
    { x: 9, y: 0 },
    { maxSnapDistance: 0 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.distance, 8);
});

test("rejects invalid constructor and router option shapes", () => {
  for (const input of [null, [], "router"]) {
    assert.throws(() => new GapRouter(input), /router input must be an object/);
  }
  for (const options of [null, [], "options"]) {
    assert.throws(
      () => new GapRouter({ nodes: [], segments: [], options }),
      /options must be an object/,
    );
  }
  for (const [name, value, message] of [
    ["mergeTolerance", -1, /finite non-negative/],
    ["endpointTolerance", Infinity, /finite non-negative/],
    ["gapSpeed", 0, /finite positive/],
    ["segmentSampleStep", NaN, /finite positive/],
    ["gapConnectorsPerNode", 1.5, /non-negative integer/],
    ["maxFallbackBridges", -1, /non-negative integer/],
    ["maxFallbackBridgeDistance", NaN, /non-negative number/],
    ["respectOneWay", 1, /must be a boolean/],
  ]) {
    assert.throws(
      () => new GapRouter({
        nodes: [],
        segments: [],
        options: { [name]: value },
      }),
      message,
    );
  }
});

test("supports Map nodes and rejects invalid node collections", () => {
  const router = new GapRouter({
    nodes: new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 1, y: 0 }],
    ]),
    segments: [{
      id: "line",
      from: "a",
      to: "b",
      coordinates: [[0, 0], [1, 0]],
    }],
    options: { maxGapDistance: 0, mergeTolerance: 0 },
  });
  assert.equal(
    router.route(
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { maxSnapDistance: 0 },
    ).ok,
    true,
  );

  assert.throws(
    () => new GapRouter({ nodes: {}, segments: [] }),
    /nodes must be a Map or an array/,
  );
  assert.throws(
    () => new GapRouter({
      nodes: new Map([[Symbol("a"), { x: 0, y: 0 }]]),
      segments: [],
    }),
    /node ids must be strings or finite numbers/,
  );
  assert.throws(
    () => new GapRouter({
      nodes: [{ id: null, x: 0, y: 0 }],
      segments: [],
    }),
    /node ids must be strings or finite numbers/,
  );
  assert.throws(
    () => new GapRouter({
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "a", x: 1, y: 0 },
      ],
      segments: [],
    }),
    /duplicate node id/,
  );
});

test("rejects malformed segment records", () => {
  const nodes = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 1, y: 0 },
  ];
  const construct = (segments) => new GapRouter({
    nodes,
    segments,
    options: { mergeTolerance: 0 },
  });

  assert.throws(() => construct(null), /segments must be an array/);
  assert.throws(
    () => construct([null]),
    /every segment needs/,
  );
  assert.throws(
    () => construct([
      {
        id: "line",
        from: "a",
        to: "b",
        coordinates: [[0, 0], [1, 0]],
      },
      {
        id: "line",
        from: "a",
        to: "b",
        coordinates: [[0, 0], [1, 0]],
      },
    ]),
    /duplicate segment id/,
  );
  assert.throws(
    () => construct([{
      id: "line",
      from: "a",
      to: "missing",
      coordinates: [[0, 0], [1, 0]],
    }]),
    /unknown node/,
  );
  assert.throws(
    () => construct([{
      id: "line",
      from: "a",
      to: "b",
      coordinates: [[0, 0]],
    }]),
    /at least two coordinates/,
  );
  assert.throws(
    () => construct([{
      id: "line",
      from: "a",
      to: "a",
      coordinates: [[0, 0], [0, 0]],
    }]),
    /positive geometry length/,
  );
  assert.throws(
    () => construct([{
      id: "line",
      from: "a",
      to: "b",
      coordinates: [[0, 0], [1, 0]],
      length: 0,
    }]),
    /length must be a finite positive number/,
  );
  assert.throws(
    () => construct([{
      id: "line",
      from: "a",
      to: "b",
      coordinates: [[0, 0], [1, 0]],
      speed: 0,
    }]),
    /speed must be a finite positive number/,
  );
  assert.throws(
    () => construct([{
      id: "line",
      from: "a",
      to: "b",
      coordinates: [[0, 0], [1, 0]],
      oneWay: "yes",
    }]),
    /oneWay must be a boolean/,
  );
});

test("rejects invalid per-route option values", () => {
  const router = new GapRouter({
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
  const start = { x: 1, y: 0 };
  const goal = { x: 9, y: 0 };

  for (const options of [null, [], "options"]) {
    assert.throws(
      () => router.route(start, goal, options),
      /route options must be an object/,
    );
  }
  for (const [options, message] of [
    [{ maxSnapDistance: -1 }, /finite non-negative/],
    [{ anchorCandidateCount: 0 }, /positive integer/],
    [{ maxFallbackBridges: -1 }, /non-negative integer/],
    [{ maxFallbackBridgeDistance: NaN }, /non-negative number/],
  ]) {
    assert.throws(() => router.route(start, goal, options), message);
  }
  assert.deepEqual(
    router.route(start, { x: 100, y: 100 }, { maxSnapDistance: 1 }),
    { ok: false, reason: "goal-not-near-network" },
  );
});
