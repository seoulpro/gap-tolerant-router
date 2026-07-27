import assert from "node:assert/strict";
import test from "node:test";

import {
  GapRouter,
  buildInstructions,
  projectPointToLine,
} from "../src/index.js";

const segment = (id, from, to, coordinates, extra = {}) => ({
  id,
  from,
  to,
  coordinates,
  speed: 10,
  ...extra,
});

test("projects an arbitrary point onto a polyline", () => {
  const projection = projectPointToLine(
    { x: 8, y: 3 },
    [[0, 0], [10, 0], [10, 10]],
  );
  assert.deepEqual(
    { x: projection.x, y: projection.y, distance: projection.distance },
    { x: 10, y: 3, distance: 2 },
  );
});

test("merges nearly coincident endpoint records", () => {
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
    options: { mergeTolerance: 1, maxGapDistance: 0 },
  });

  const result = router.route({ x: 1, y: 0 }, { x: 19, y: 0 }, {
    maxSnapDistance: 3,
  });
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.mergedNodes, 1);
  assert.equal(result.legs.some((leg) => leg.reason === "nearby-components"), false);
});

test("adds penalized connectors between nearby components", () => {
  const router = new GapRouter({
    nodes: [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 10, y: 0 },
      { id: 3, x: 14, y: 0 },
      { id: 4, x: 24, y: 0 },
    ],
    segments: [
      segment("a", 1, 2, [[0, 0], [10, 0]]),
      segment("b", 3, 4, [[14, 0], [24, 0]]),
    ],
    options: { maxGapDistance: 5 },
  });

  const result = router.route({ x: 1, y: 0 }, { x: 23, y: 0 }, {
    maxSnapDistance: 3,
  });
  assert.equal(result.ok, true);
  assert.equal(result.legs.some((leg) => leg.kind === "gap"), true);
  assert.ok(result.cost > result.distance / 10);
});

test("projects a nearby dead end onto a foreign segment", () => {
  const router = new GapRouter({
    nodes: [
      { id: "stem-start", x: 5, y: -10 },
      { id: "stem-end", x: 5, y: -1 },
      { id: "bar-start", x: 0, y: 0 },
      { id: "bar-end", x: 10, y: 0 },
    ],
    segments: [
      segment(
        "stem",
        "stem-start",
        "stem-end",
        [[5, -10], [5, -1]],
      ),
      segment(
        "bar",
        "bar-start",
        "bar-end",
        [[0, 0], [10, 0]],
      ),
    ],
    options: { maxGapDistance: 2 },
  });

  const result = router.route(
    { x: 5, y: -9 },
    { x: 9, y: 0 },
    { maxSnapDistance: 2 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.projectedDeadEnds, 1);
  assert.equal(
    result.legs.some((leg) => leg.reason === "dead-end-projection"),
    true,
  );
});

test("routes two anchors directly along the same segment", () => {
  const router = new GapRouter({
    nodes: [
      { id: "start", x: 0, y: 0 },
      { id: "end", x: 100, y: 0 },
    ],
    segments: [
      segment("main", "start", "end", [[0, 0], [40, 0], [100, 0]]),
    ],
    options: { maxGapDistance: 0 },
  });

  const result = router.route({ x: 20, y: 3 }, { x: 30, y: -2 }, {
    maxSnapDistance: 5,
  });
  assert.equal(result.ok, true);
  assert.ok(result.distance < 16, `unexpected endpoint detour: ${result.distance}`);
});

test("does not traverse a one-way segment in reverse", () => {
  const input = {
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 10, y: 0 },
    ],
    segments: [
      segment(
        "one-way",
        "a",
        "b",
        [[0, 0], [10, 0]],
        { oneWay: true },
      ),
    ],
    options: { maxGapDistance: 0 },
  };
  const router = new GapRouter(input);

  assert.equal(
    router.route(
      { x: 1, y: 0 },
      { x: 9, y: 0 },
      { maxSnapDistance: 1 },
    ).ok,
    true,
  );
  assert.deepEqual(
    router.route(
      { x: 9, y: 0 },
      { x: 1, y: 0 },
      { maxSnapDistance: 1 },
    ),
    { ok: false, reason: "no-route" },
  );
});

test("keeps long fallback bridges opt-in", () => {
  const input = {
    nodes: [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 10, y: 0 },
      { id: 3, x: 100, y: 0 },
      { id: 4, x: 110, y: 0 },
    ],
    segments: [
      segment("left", 1, 2, [[0, 0], [10, 0]]),
      segment("right", 3, 4, [[100, 0], [110, 0]]),
    ],
    options: { maxGapDistance: 5 },
  };
  const router = new GapRouter(input);
  assert.equal(
    router.route({ x: 1, y: 0 }, { x: 109, y: 0 }, { maxSnapDistance: 3 }).ok,
    false,
  );

  const fallbackRouter = new GapRouter(input);
  const result = fallbackRouter.route(
    { x: 1, y: 0 },
    { x: 109, y: 0 },
    {
      maxSnapDistance: 3,
      maxFallbackBridges: 1,
      maxFallbackBridgeDistance: 100,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.legs.some((leg) => leg.reason === "fallback-bridge"), true);
});

test("produces structured, localizable instructions", () => {
  const instructions = buildInstructions([
    {
      kind: "network",
      coordinates: [[0, 0], [20, 0], [20, 20]],
      length: 40,
      cost: 4,
      metadata: { class: "primary" },
    },
  ]);
  assert.deepEqual(
    instructions.map((instruction) => instruction.kind),
    ["depart", "turn", "arrive"],
  );
  assert.equal(instructions[1].modifier, "left");
});

test("rejects malformed instruction configuration", () => {
  assert.throws(
    () => buildInstructions([], { turnThreshholdDegrees: 10 }),
    /unknown instruction option/,
  );
  assert.throws(
    () => buildInstructions([], {
      slightTurnMaxDegrees: 140,
      sharpTurnMinDegrees: 100,
    }),
    /thresholds must be ordered/,
  );
  assert.throws(
    () => buildInstructions([{
      kind: "network",
      coordinates: [[0, 0], [1, Infinity]],
      length: 1,
      cost: 1,
    }]),
    /valid geometry/,
  );
});

test("scales projected subsegments when logical length differs from geometry", () => {
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
      length: 100,
      speed: 10,
    }],
  });
  const result = router.route(
    { x: 2, y: 0 },
    { x: 8, y: 0 },
    { maxSnapDistance: 1 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.distance, 60);
  assert.equal(result.cost, 6);
});

test("keeps A-star optimal when logical lengths differ from geometry", () => {
  const router = new GapRouter({
    nodes: [
      { id: "start", x: 0, y: 0 },
      { id: "detour", x: 100, y: 100 },
      { id: "goal", x: 1, y: 0 },
    ],
    segments: [
      segment(
        "direct",
        "start",
        "goal",
        [[0, 0], [1, 0]],
        { length: 10, speed: 1 },
      ),
      segment(
        "shortcut-out",
        "start",
        "detour",
        [[0, 0], [100, 100]],
        { length: 1, speed: 1 },
      ),
      segment(
        "shortcut-back",
        "detour",
        "goal",
        [[100, 100], [1, 0]],
        { length: 1, speed: 1 },
      ),
    ],
    options: {
      gapFixedCost: 0,
      maxGapDistance: 0,
      mergeTolerance: 0,
    },
  });

  const result = router.route(
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    {
      anchorCandidateCount: 1,
      maxSnapDistance: 0,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.cost, 2);
  assert.deepEqual(
    result.legs
      .map((leg) => leg.segmentId)
      .filter((id) => id !== undefined),
    ["shortcut-out", "shortcut-back"],
  );
});

test("does not retain query anchors between route calls", () => {
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
  });

  const first = router.route({ x: 1, y: 0 }, { x: 9, y: 0 });
  const second = router.route({ x: 1, y: 0 }, { x: 9, y: 0 });

  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.deepEqual(Object.keys(router), []);
});

test("rejects invalid graph values before building spatial indexes", () => {
  assert.throws(
    () => new GapRouter({
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: Infinity, y: 0 },
      ],
      segments: [
        segment("line", "a", "b", [[0, 0], [Infinity, 0]]),
      ],
    }),
    /finite numeric x and y/,
  );

  assert.throws(
    () => new GapRouter({
      nodes: [{ id: "a", x: 0, y: 0 }],
      segments: [
        segment("line", "a", "missing", [[0, 0], [10, 0]]),
      ],
    }),
    /unknown node/,
  );

  assert.throws(
    () => new GapRouter({
      nodes: [],
      segments: [],
      options: { maxGapDistnace: 10 },
    }),
    /unknown router option/,
  );

  const empty = new GapRouter({ nodes: [], segments: [] });
  assert.throws(
    () => empty.route(
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { maxSnapDistnace: 10 },
    ),
    /unknown route option/,
  );
});

test("keeps generated anchor ids separate from caller node ids", () => {
  const router = new GapRouter({
    nodes: [
      { id: "@@gap-router:1", x: 0, y: 0 },
      { id: "end", x: 10, y: 0 },
    ],
    segments: [
      segment(
        "line",
        "@@gap-router:1",
        "end",
        [[0, 0], [10, 0]],
      ),
    ],
    options: { maxGapDistance: 0 },
  });

  const result = router.route(
    { x: 1, y: 1 },
    { x: 9, y: -1 },
    { maxSnapDistance: 2 },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.coordinates[0], [1, 1]);
  assert.deepEqual(result.coordinates.at(-1), [9, -1]);
});
