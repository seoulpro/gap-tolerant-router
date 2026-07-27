import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { GapRouter } from "../src/index.js";

test("builds and searches a long network within a bounded smoke-test budget", {
  timeout: 15_000,
}, () => {
  const count = 2_000;
  const nodes = [];
  const segments = [];
  for (let index = 0; index < count; index += 1) {
    nodes.push({ id: index, x: index, y: 0 });
    if (index > 0) {
      segments.push({
        id: index - 1,
        from: index - 1,
        to: index,
        coordinates: [[index - 1, 0], [index, 0]],
        speed: 1,
      });
    }
  }

  const started = performance.now();
  const router = new GapRouter({
    nodes,
    segments,
    options: { maxGapDistance: 0, mergeTolerance: 0 },
  });
  const result = router.route(
    { x: 0, y: 0 },
    { x: count - 1, y: 0 },
    { anchorCandidateCount: 1, maxSnapDistance: 0 },
  );
  const elapsed = performance.now() - started;

  assert.equal(result.ok, true);
  assert.equal(result.distance, count - 1);
  assert.ok(elapsed < 10_000, `smoke test took ${elapsed}ms`);
});
