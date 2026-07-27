import assert from "node:assert/strict";
import test from "node:test";

import { GapRouter } from "../src/index.js";

const closeTo = (actual, expected, tolerance = 1e-9) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} is not within ${tolerance} of ${expected}`,
  );
};

const assertRouteInvariants = (result, start, goal) => {
  assert.equal(result.ok, true);
  closeTo(
    result.distance,
    result.legs.reduce((sum, leg) => sum + leg.length, 0),
  );
  closeTo(
    result.cost,
    result.legs.reduce((sum, leg) => sum + leg.cost, 0),
  );
  assert.deepEqual(result.coordinates[0], [start.x, start.y]);
  assert.deepEqual(result.coordinates.at(-1), [goal.x, goal.y]);
  for (const leg of result.legs) {
    assert.ok(leg.length >= 0);
    assert.ok(leg.cost >= 0);
    assert.ok(leg.coordinates.length >= 2);
  }
  for (let index = 1; index < result.legs.length; index += 1) {
    assert.deepEqual(
      result.legs[index - 1].coordinates.at(-1),
      result.legs[index].coordinates[0],
    );
  }
};

const shuffled = (values, seed) => {
  const output = values.slice();
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [output[index], output[target]] = [output[target], output[index]];
  }
  return output;
};

test("produces the same equal-cost route regardless of input order", () => {
  const nodes = [
    { id: "start", x: 0, y: 0 },
    { id: "upper", x: 1, y: 1 },
    { id: "lower", x: 1, y: -1 },
    { id: "goal", x: 2, y: 0 },
  ];
  const segments = [
    {
      id: "a-start",
      from: "start",
      to: "upper",
      coordinates: [[0, 0], [1, 1]],
      speed: 1,
    },
    {
      id: "a-goal",
      from: "upper",
      to: "goal",
      coordinates: [[1, 1], [2, 0]],
      speed: 1,
    },
    {
      id: "b-start",
      from: "start",
      to: "lower",
      coordinates: [[0, 0], [1, -1]],
      speed: 1,
    },
    {
      id: "b-goal",
      from: "lower",
      to: "goal",
      coordinates: [[1, -1], [2, 0]],
      speed: 1,
    },
  ];
  const build = (nodeInput, segmentInput) => new GapRouter({
    nodes: nodeInput,
    segments: segmentInput,
    options: { maxGapDistance: 0, mergeTolerance: 0 },
  });
  const options = { anchorCandidateCount: 1, maxSnapDistance: 0 };

  const ordered = build(nodes, segments).route(
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    options,
  );
  const permuted = build(
    shuffled(nodes, 1),
    shuffled(segments, 2),
  ).route(
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    options,
  );

  assert.deepEqual(permuted, ordered);
  assert.deepEqual(
    ordered.legs.map((leg) => leg.segmentId),
    ["a-start", "a-goal"],
  );
});

test("preserves cost and geometry invariants over seeded grid queries", () => {
  const size = 8;
  const nodes = [];
  const segments = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      nodes.push({ id: `${x}:${y}`, x: x * 10, y: y * 10 });
      if (x > 0) {
        segments.push({
          id: `h:${x - 1}:${y}`,
          from: `${x - 1}:${y}`,
          to: `${x}:${y}`,
          coordinates: [[(x - 1) * 10, y * 10], [x * 10, y * 10]],
          speed: 2,
        });
      }
      if (y > 0) {
        segments.push({
          id: `v:${x}:${y - 1}`,
          from: `${x}:${y - 1}`,
          to: `${x}:${y}`,
          coordinates: [[x * 10, (y - 1) * 10], [x * 10, y * 10]],
          speed: 2,
        });
      }
    }
  }
  const router = new GapRouter({
    nodes: shuffled(nodes, 3),
    segments: shuffled(segments, 4),
    options: { maxGapDistance: 0, mergeTolerance: 0 },
  });

  let state = 5;
  const next = () => {
    state = (state * 48_271) % 2_147_483_647;
    return state;
  };
  for (let query = 0; query < 30; query += 1) {
    const startIndex = next() % nodes.length;
    let goalIndex = next() % nodes.length;
    if (goalIndex === startIndex) goalIndex = (goalIndex + 1) % nodes.length;
    const start = nodes[startIndex];
    const goal = nodes[goalIndex];
    const routeOptions = {
      anchorCandidateCount: 1,
      maxSnapDistance: 0,
    };
    const first = router.route(start, goal, routeOptions);
    const second = router.route(start, goal, routeOptions);
    assertRouteInvariants(first, start, goal);
    assert.deepEqual(second, first);
  }
});

test("gives symmetric costs on a two-way chain", () => {
  const nodes = [];
  const segments = [];
  for (let index = 0; index < 50; index += 1) {
    nodes.push({
      id: index,
      x: index * 3,
      y: Math.sin(index / 4),
    });
    if (index > 0) {
      const previous = nodes[index - 1];
      const current = nodes[index];
      segments.push({
        id: index - 1,
        from: index - 1,
        to: index,
        coordinates: [
          [previous.x, previous.y],
          [current.x, current.y],
        ],
        speed: 3,
      });
    }
  }
  const router = new GapRouter({
    nodes,
    segments,
    options: { maxGapDistance: 0, mergeTolerance: 0 },
  });
  const start = nodes[0];
  const goal = nodes.at(-1);
  const options = { anchorCandidateCount: 1, maxSnapDistance: 0 };
  const forward = router.route(start, goal, options);
  const reverse = router.route(goal, start, options);

  assertRouteInvariants(forward, start, goal);
  assertRouteInvariants(reverse, goal, start);
  closeTo(forward.distance, reverse.distance);
  closeTo(forward.cost, reverse.cost);
  assert.deepEqual(
    reverse.coordinates,
    forward.coordinates.slice().reverse(),
  );
});

test("keeps route geometry continuous across an ordinary gap", () => {
  const router = new GapRouter({
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 10, y: 0 },
      { id: "c", x: 14, y: 0 },
      { id: "d", x: 24, y: 0 },
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
        coordinates: [[14, 0], [24, 0]],
      },
    ],
    options: { maxGapDistance: 5, mergeTolerance: 0 },
  });
  const start = { x: 1, y: 1 };
  const goal = { x: 23, y: -1 };
  const result = router.route(start, goal, { maxSnapDistance: 2 });

  assertRouteInvariants(result, start, goal);
  assert.equal(result.legs.some((routeLeg) => routeLeg.kind === "gap"), true);
});
