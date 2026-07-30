import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  GapRouter,
  lineLength,
  projectPointToLine,
} from "../src/index.js";

test("routes valid geometry far below the former absolute epsilon", () => {
  const length = 1e-200;
  const router = new GapRouter({
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: length, y: 0 },
    ],
    segments: [{
      id: "tiny",
      from: "a",
      to: "b",
      coordinates: [[0, 0], [length, 0]],
      speed: 1,
    }],
    options: { maxGapDistance: 0, mergeTolerance: 0 },
  });

  const result = router.route(
    { x: 0, y: 0 },
    { x: length, y: 0 },
    { anchorCandidateCount: 1, maxSnapDistance: 0 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.distance, length);
  assert.equal(result.cost, length);
  assert.deepEqual(result.coordinates, [[0, 0], [length, 0]]);
});

test("projects onto very large finite geometry without producing NaN", () => {
  const projection = projectPointToLine(
    { x: 5e199, y: 1 },
    [[0, 0], [1e200, 0]],
  );

  assert.ok(projection);
  assert.equal(projection.t, 0.5);
  assert.equal(projection.x, 5e199);
  assert.equal(projection.y, 0);
  assert.equal(projection.distance, 1);
  for (const value of Object.values(projection)) {
    assert.equal(Number.isFinite(value), true);
  }
});

test("projects onto a tiny segment despite a large orthogonal offset", () => {
  const projection = projectPointToLine(
    { x: 5e-301, y: 1e100 },
    [[0, 0], [1e-300, 0]],
  );

  assert.ok(projection);
  assert.equal(projection.t, 0.5);
  assert.equal(projection.x, 5e-301);
  assert.equal(projection.y, 0);
  assert.equal(projection.distance, 1e100);
  assert.equal(projection.distanceAlong, 5e-301);
});

test("keeps a subnormal interior point distinct from an endpoint", () => {
  const start = -2.2250738585081865e-308;
  const end = 2.2250738585081865e-308;
  const point = 2.225073858508186e-308;
  const projection = projectPointToLine(
    { x: point, y: 0 },
    [[start, 0], [end, 0]],
  );

  assert.ok(projection);
  assert.ok(projection.t > 0 && projection.t < 1);
  assert.equal(projection.x, point);
  assert.equal(projection.y, 0);
  assert.equal(projection.distance, 0);
});

test("keeps large axis projections invariant when a segment is reversed", () => {
  const point = { x: 1e262, y: 0 };
  const forward = projectPointToLine(point, [[0, 0], [1e263, 0]]);
  const reverse = projectPointToLine(point, [[1e263, 0], [0, 0]]);

  assert.ok(forward);
  assert.ok(reverse);
  assert.deepEqual(
    [forward.x, forward.y, forward.distance],
    [point.x, point.y, 0],
  );
  assert.deepEqual(
    [reverse.x, reverse.y, reverse.distance],
    [point.x, point.y, 0],
  );
  assert.equal(forward.t, 0.1);
  assert.equal(reverse.t, 0.9);
});

test("separates exact distance from rounded projected coordinates", () => {
  const projection = projectPointToLine(
    { x: 1e16 + 2, y: 1e16 + 2 },
    [[1e16, 1e16], [1e16 + 4, 1e16 + 8]],
  );

  assert.ok(projection);
  assert.deepEqual(
    [projection.x, projection.y],
    [1e16 + 2, 1e16 + 2],
  );
  assert.equal(projection.t, 0.3);
  assert.equal(projection.distance, Math.sqrt(0.8));
});

test("preserves an interior subnormal distance along a segment", () => {
  const projection = projectPointToLine(
    { x: Number.MIN_VALUE, y: 0 },
    [[0, 0], [Number.MIN_VALUE, Number.MIN_VALUE]],
  );

  assert.ok(projection);
  assert.equal(projection.t, 0.5);
  assert.equal(projection.distance, Number.MIN_VALUE);
  assert.equal(projection.distanceAlong, Number.MIN_VALUE);
});

test("keeps exact endpoint projections out of the interior", () => {
  const point = { x: -2.3125, y: -3.1875 };
  const start = [-1.3125, -1.6875];
  const end = [-1.5, -1.5625];
  const forward = projectPointToLine(point, [start, end]);
  const reverse = projectPointToLine(point, [end, start]);

  assert.ok(forward);
  assert.ok(reverse);
  assert.equal(forward.t, 0);
  assert.equal(reverse.t, 1);
  assert.deepEqual([forward.x, forward.y], start);
  assert.deepEqual([reverse.x, reverse.y], start);
});

test("does not amplify a subnormal interior fraction near an endpoint", () => {
  const point = { x: 0, y: -Number.MIN_VALUE };
  const start = [0, 0];
  const end = [-5, -7];
  const forward = projectPointToLine(point, [start, end]);
  const reverse = projectPointToLine(point, [end, start]);

  assert.ok(forward);
  assert.ok(reverse);
  assert.equal(forward.t, Number.MIN_VALUE);
  assert.equal(reverse.t, 1 - Number.EPSILON / 2);
  assert.deepEqual([forward.x, forward.y], [0, -Number.MIN_VALUE]);
  assert.deepEqual([reverse.x, reverse.y], [0, -Number.MIN_VALUE]);
  assert.equal(forward.distance, Number.MIN_VALUE);
  assert.equal(reverse.distance, Number.MIN_VALUE);
  assert.equal(forward.distanceAlong, Number.MIN_VALUE);
  assert.equal(reverse.distanceAlong, Math.hypot(5, 7));
});

test("preserves a positive exact distance below binary64 range", () => {
  const length = 2 ** 500;
  const projection = projectPointToLine(
    { x: 0, y: Number.MIN_VALUE },
    [[0, 0], [-length, 4 * length]],
  );

  assert.ok(projection);
  assert.equal(projection.t, Number.MIN_VALUE);
  assert.deepEqual(
    [projection.x, projection.y],
    [0, Number.MIN_VALUE],
  );
  assert.equal(projection.distance, Number.MIN_VALUE);
  assert.equal(projection.distanceAlong, Number.MIN_VALUE);
});

test("returns the input point for an exact collinear interior projection", () => {
  const point = { x: -134, y: 155 };
  const projection = projectPointToLine(
    point,
    [[-2, 1], [-296, 344]],
  );

  assert.ok(projection);
  assert.equal(projection.t, 22 / 49);
  assert.deepEqual([projection.x, projection.y], [point.x, point.y]);
  assert.equal(projection.distance, 0);
});

test("falls back from unsafe spatial cell indexes without hanging", () => {
  const entrypoint = new URL("../src/index.js", import.meta.url).href;
  const script = `
    import { GapRouter } from ${JSON.stringify(entrypoint)};
    new GapRouter({
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 1e16, y: 0 }
      ],
      segments: [{
        id: "line",
        from: "a",
        to: "b",
        coordinates: [[0, 0], [1e16, 0]]
      }],
      options: {
        maxGapDistance: 0,
        maxFallbackBridges: 0,
        mergeTolerance: 0,
        segmentSampleStep: 1e16
      }
    });
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: 2_000 },
  );

  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});

test("keeps a real interior projection on a very long segment", () => {
  const router = new GapRouter({
    nodes: [
      { id: "target-a", x: 0, y: 0 },
      { id: "target-b", x: 1e16, y: 0 },
      { id: "source-a", x: 1, y: 10 },
      { id: "source-tip", x: 1, y: 1 },
    ],
    segments: [
      {
        id: "target",
        from: "target-a",
        to: "target-b",
        coordinates: [[0, 0], [1e16, 0]],
      },
      {
        id: "source",
        from: "source-a",
        to: "source-tip",
        coordinates: [[1, 10], [1, 1]],
      },
    ],
    options: {
      gapConnectorsPerNode: 0,
      maxFallbackBridges: 0,
      maxGapDistance: 1,
      mergeTolerance: 0,
      projectionMinGain: 0,
      segmentSampleStep: 1e16,
    },
  });

  const result = router.route(
    { x: 1, y: 1 },
    { x: 2, y: 0 },
    { anchorCandidateCount: 2, maxSnapDistance: 0 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.distance, 2);
  assert.ok(result.coordinates.some(
    ([x, y]) => x === 1 && y === 0,
  ));
});

test("rejects geometric distances that exceed finite numeric range", () => {
  assert.throws(
    () => lineLength([[-1e308, 0], [1e308, 0]]),
    /coordinate length must remain finite/,
  );
  assert.throws(
    () => projectPointToLine(
      { x: 0, y: 0 },
      [[-1e308, 0], [1e308, 0]],
    ),
    /segment length must remain finite/,
  );
});

test("rejects non-finite segment and gap costs during construction", () => {
  assert.throws(
    () => new GapRouter({
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 1, y: 0 },
      ],
      segments: [{
        id: "line",
        from: "a",
        to: "b",
        coordinates: [[0, 0], [1, 0]],
        length: 1e308,
        speed: 1e-308,
      }],
      options: { maxGapDistance: 0, mergeTolerance: 0 },
    }),
    /segment .* cost must remain finite/,
  );

  assert.throws(
    () => new GapRouter({
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 1, y: 0 },
        { id: "c", x: 2, y: 0 },
        { id: "d", x: 3, y: 0 },
      ],
      segments: [
        {
          id: "left",
          from: "a",
          to: "b",
          coordinates: [[0, 0], [1, 0]],
        },
        {
          id: "right",
          from: "c",
          to: "d",
          coordinates: [[2, 0], [3, 0]],
        },
      ],
      options: {
        gapCostFactor: 1e308,
        gapSpeed: 1e-308,
        maxGapDistance: 2,
        mergeTolerance: 0,
      },
    }),
    /gap cost must remain finite/,
  );
});

test("rejects route cost overflow instead of returning Infinity", () => {
  const router = new GapRouter({
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
        length: 1e308,
        speed: 1,
      },
      {
        id: "bc",
        from: "b",
        to: "c",
        coordinates: [[1, 0], [2, 0]],
        length: 1e308,
        speed: 1,
      },
    ],
    options: { maxGapDistance: 0, mergeTolerance: 0 },
  });

  assert.throws(
    () => router.route(
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { anchorCandidateCount: 1, maxSnapDistance: 0 },
    ),
    /route cost must remain finite/,
  );
});

test("rejects route distance overflow instead of returning Infinity", () => {
  const router = new GapRouter({
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 1e308, y: 0 },
      { id: "c", x: 1e308, y: 1e308 },
    ],
    segments: [
      {
        id: "ab",
        from: "a",
        to: "b",
        coordinates: [[0, 0], [1e308, 0]],
        speed: Number.MAX_VALUE,
      },
      {
        id: "bc",
        from: "b",
        to: "c",
        coordinates: [[1e308, 0], [1e308, 1e308]],
        speed: Number.MAX_VALUE,
      },
    ],
    options: {
      maxGapDistance: 0,
      mergeTolerance: 0,
      segmentSampleStep: 1e308,
    },
  });

  assert.throws(
    () => router.route(
      { x: 0, y: 0 },
      { x: 1e308, y: 1e308 },
      { anchorCandidateCount: 1, maxSnapDistance: 0 },
    ),
    /route distance must remain finite/,
  );
});
