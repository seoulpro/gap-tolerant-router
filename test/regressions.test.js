import assert from "node:assert/strict";
import test from "node:test";

import { GapRouter, buildInstructions } from "../src/index.js";

const segment = (id, from, to, coordinates, extra = {}) => ({
  id,
  from,
  to,
  coordinates,
  speed: 10,
  ...extra,
});

test("returns a zero-length route when start and goal are identical", () => {
  const router = new GapRouter({
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 10, y: 0 },
    ],
    segments: [segment("line", "a", "b", [[0, 0], [10, 0]])],
    options: { maxGapDistance: 0, mergeTolerance: 0 },
  });

  assert.deepEqual(
    router.route(
      { x: 5, y: 0 },
      { x: 5, y: 0 },
      { maxSnapDistance: 0 },
    ),
    {
      ok: true,
      coordinates: [[5, 0]],
      legs: [],
      distance: 0,
      cost: 0,
      snapDistance: { start: 0, goal: 0 },
      diagnostics: {
        mergedNodes: 0,
        gapConnectors: 0,
        projectedDeadEnds: 0,
        fallbackBridges: 0,
      },
    },
  );
  assert.deepEqual(
    router.route(
      { x: 50, y: 50 },
      { x: 50, y: 50 },
      { maxSnapDistance: 1 },
    ),
    { ok: false, reason: "start-not-near-network" },
  );
});

test("reuses a junction node when an anchor lands on a segment endpoint", () => {
  const router = new GapRouter({
    nodes: [
      { id: "origin", x: 0, y: 0 },
      { id: "east", x: 10, y: 0 },
      { id: "north", x: 0, y: 10 },
    ],
    segments: [
      segment("east", "origin", "east", [[0, 0], [10, 0]], { speed: 1 }),
      segment("north", "origin", "north", [[0, 0], [0, 10]], { speed: 1 }),
    ],
    options: { maxGapDistance: 0, mergeTolerance: 0 },
  });

  const result = router.route(
    { x: 0, y: 0 },
    { x: 0, y: 9 },
    { anchorCandidateCount: 1, maxSnapDistance: 0 },
  );

  assert.equal(result.ok, true);
  assert.equal(result.distance, 9);
  assert.equal(result.cost, 9);
  assert.deepEqual(result.coordinates, [[0, 0], [0, 9]]);
  assert.deepEqual(
    result.legs.map((leg) => leg.segmentId),
    ["north"],
  );
});

test("snaps exactly to decimal segment endpoints at zero tolerance", () => {
  const router = new GapRouter({
    nodes: [
      { id: "a", x: 0, y: 0.0009 },
      { id: "b", x: 100, y: 300.0009 },
    ],
    segments: [
      segment(
        "line",
        "b",
        "a",
        [[100, 300.0009], [0, 0.0009]],
      ),
    ],
    options: { maxGapDistance: 0, mergeTolerance: 0 },
  });

  const result = router.route(
    { x: 100, y: 300.0009 },
    { x: 0, y: 0.0009 },
    { maxSnapDistance: 0 },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.coordinates[0], [100, 300.0009]);
  assert.deepEqual(result.coordinates.at(-1), [0, 0.0009]);
});

test("keeps projected decimal geometry continuous through a junction", () => {
  const router = new GapRouter({
    nodes: [
      { id: "a", x: 0, y: 0.0009 },
      { id: "b", x: 100, y: 300.0009 },
      { id: "c", x: -100, y: -99.9991 },
    ],
    segments: [
      segment(
        "ba",
        "b",
        "a",
        [[100, 300.0009], [0, 0.0009]],
        { speed: 1 },
      ),
      segment(
        "ac",
        "a",
        "c",
        [[0, 0.0009], [-100, -99.9991]],
        { speed: 1 },
      ),
    ],
    options: { maxGapDistance: 0, mergeTolerance: 0 },
  });

  const result = router.route(
    { x: 50, y: 150.0009 },
    { x: -100, y: -99.9991 },
    { maxSnapDistance: 0 },
  );

  assert.equal(result.ok, true);
  for (let index = 1; index < result.legs.length; index += 1) {
    assert.deepEqual(
      result.legs[index - 1].coordinates.at(-1),
      result.legs[index].coordinates[0],
    );
  }
  assert.deepEqual(result.coordinates, [
    [50, 150.0009],
    [0, 0.0009],
    [-100, -99.9991],
  ]);
});

test("keeps returned route data isolated from later searches", () => {
  const router = new GapRouter({
    nodes: [0, 1, 2, 3].map((id) => ({ id, x: id * 10, y: 0 })),
    segments: [0, 1, 2].map((id) => (
      segment(id, id, id + 1, [[id * 10, 0], [(id + 1) * 10, 0]])
    )),
    options: { maxGapDistance: 0, mergeTolerance: 0 },
  });

  const first = router.route(
    { x: 2, y: 0 },
    { x: 28, y: 0 },
    { anchorCandidateCount: 1, maxSnapDistance: 1 },
  );
  assert.equal(first.ok, true);
  const middle = first.legs.find((leg) => leg.segmentId === 1);
  middle.cost = 999;
  middle.coordinates[0][0] = 777;
  first.coordinates[0][0] = -100;

  const second = router.route(
    { x: 2, y: 0 },
    { x: 28, y: 0 },
    { anchorCandidateCount: 1, maxSnapDistance: 1 },
  );
  assert.equal(second.ok, true);
  assert.equal(second.cost, 2.6);
  assert.deepEqual(second.coordinates, [[2, 0], [10, 0], [20, 0], [28, 0]]);
});

test("preserves instruction distance when nearby turns are combined", () => {
  const instructions = buildInstructions([
    {
      kind: "network",
      length: 30,
      cost: 30,
      coordinates: [[0, 0], [10, 0], [18, 4], [18, 14]],
    },
  ], {
    minimumEventSpacing: 20,
    turnThresholdDegrees: 10,
  });

  assert.deepEqual(
    instructions.map((instruction) => instruction.kind),
    ["depart", "turn", "arrive"],
  );
  assert.equal(
    instructions.reduce((sum, instruction) => sum + instruction.distance, 0),
    30,
  );
  assert.equal(
    instructions.reduce((sum, instruction) => sum + instruction.cost, 0),
    30,
  );
  assert.deepEqual(instructions[1].at, { x: 18, y: 4 });
});

test("routes around a self-loop in either direction", () => {
  const input = {
    nodes: [{ id: "loop", x: 0, y: 0 }],
    segments: [
      segment(
        "loop",
        "loop",
        "loop",
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        { length: 40, oneWay: true, speed: 10 },
      ),
    ],
    options: { maxGapDistance: 0, mergeTolerance: 0 },
  };
  const router = new GapRouter(input);

  const forward = router.route(
    { x: 2, y: 0 },
    { x: 0, y: 2 },
    { maxSnapDistance: 0 },
  );
  const aroundEnd = router.route(
    { x: 0, y: 2 },
    { x: 2, y: 0 },
    { maxSnapDistance: 0 },
  );

  assert.equal(forward.ok, true);
  assert.equal(forward.distance, 36);
  assert.equal(aroundEnd.ok, true);
  assert.equal(aroundEnd.distance, 4);
});

test("can explicitly ignore one-way restrictions at construction", () => {
  const router = new GapRouter({
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 10, y: 0 },
    ],
    segments: [
      segment("line", "a", "b", [[0, 0], [10, 0]], { oneWay: true }),
    ],
    options: {
      maxGapDistance: 0,
      mergeTolerance: 0,
      respectOneWay: false,
    },
  });

  const result = router.route(
    { x: 9, y: 0 },
    { x: 1, y: 0 },
    { maxSnapDistance: 0 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.distance, 8);
});

test("does not use fallback bridges to bypass a one-way segment", () => {
  const router = new GapRouter({
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 10, y: 0 },
    ],
    segments: [
      segment("line", "a", "b", [[0, 0], [10, 0]], { oneWay: true }),
    ],
    options: { maxGapDistance: 0, mergeTolerance: 0 },
  });

  assert.deepEqual(
    router.route(
      { x: 9, y: 0 },
      { x: 1, y: 0 },
      {
        maxFallbackBridges: 1,
        maxFallbackBridgeDistance: 20,
        maxSnapDistance: 0,
      },
    ),
    { ok: false, reason: "no-route" },
  );
});

test("normalizes merged segment endpoints to continuous route geometry", () => {
  const router = new GapRouter({
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 10, y: 0 },
      { id: "b-copy", x: 10.4, y: 0.2 },
      { id: "c", x: 20, y: 0 },
    ],
    segments: [
      segment("left", "a", "b", [[0, 0], [10, 0]]),
      segment("right", "b-copy", "c", [[10.4, 0.2], [20, 0]]),
    ],
    options: { maxGapDistance: 0, mergeTolerance: 1 },
  });

  const result = router.route(
    { x: 1, y: 0 },
    { x: 19, y: 0 },
    { maxSnapDistance: 2 },
  );

  assert.equal(result.ok, true);
  for (let index = 1; index < result.legs.length; index += 1) {
    assert.deepEqual(
      result.legs[index - 1].coordinates.at(-1),
      result.legs[index].coordinates[0],
    );
  }
});

test("does not merge the two endpoints of a real short segment", () => {
  const router = new GapRouter({
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 0.5, y: 0 },
    ],
    segments: [
      segment("short", "a", "b", [[0, 0], [0.5, 0]], { speed: 1 }),
    ],
    options: { maxGapDistance: 0, mergeTolerance: 1 },
  });

  const result = router.route(
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { maxSnapDistance: 0 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.distance, 0.5);
  assert.equal(result.diagnostics.mergedNodes, 0);
});

test("uses exactly the allowed number of fallback bridges", () => {
  const router = new GapRouter({
    nodes: [0, 10, 100, 110, 200, 210].map((x) => ({
      id: String(x),
      x,
      y: 0,
    })),
    segments: [
      segment("a", "0", "10", [[0, 0], [10, 0]]),
      segment("b", "100", "110", [[100, 0], [110, 0]]),
      segment("c", "200", "210", [[200, 0], [210, 0]]),
    ],
    options: { maxGapDistance: 0, mergeTolerance: 0 },
  });

  assert.deepEqual(
    router.route(
      { x: 1, y: 0 },
      { x: 209, y: 0 },
      {
        maxFallbackBridges: 1,
        maxFallbackBridgeDistance: 100,
        maxSnapDistance: 1,
      },
    ),
    { ok: false, reason: "no-route" },
  );

  const result = router.route(
    { x: 1, y: 0 },
    { x: 209, y: 0 },
    {
      maxFallbackBridges: 2,
      maxFallbackBridgeDistance: 100,
      maxSnapDistance: 1,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.fallbackBridges, 2);
  assert.deepEqual(
    result.legs
      .filter((leg) => leg.reason === "fallback-bridge")
      .map((leg) => leg.coordinates),
    [
      [[10, 0], [100, 0]],
      [[110, 0], [200, 0]],
    ],
  );
});

test("does not add duplicate gaps into the same connected component", () => {
  const router = new GapRouter({
    nodes: [
      { id: "a0", x: 0, y: 0 },
      { id: "a1", x: 0, y: 1 },
      { id: "b0", x: 4, y: 0 },
      { id: "b1", x: 4, y: 1 },
    ],
    segments: [
      segment("a", "a0", "a1", [[0, 0], [0, 1]]),
      segment("b", "b0", "b1", [[4, 0], [4, 1]]),
    ],
    options: {
      gapConnectorsPerNode: 2,
      maxGapDistance: 5,
      mergeTolerance: 0,
      projectionMinGain: 10,
    },
  });

  const result = router.route(
    { x: 0, y: 0 },
    { x: 4, y: 1 },
    { maxSnapDistance: 0 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.gapConnectors, 1);
});
