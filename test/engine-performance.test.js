import assert from "node:assert/strict";
import test from "node:test";

import { analyzeGaps } from "../src/engine.js";

test("uses a spatial index for sparse endpoint neighborhoods", () => {
  const nodes = Array.from({ length: 2_000 }, (_, index) => ({
    id: `node-${String(index).padStart(4, "0")}`,
    position: [index * 10, 0],
  }));
  const analysis = analyzeGaps({
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "sparse-index-smoke",
      revision: "r1",
      space: { dimensions: 2, unit: "m", frame: "local" },
      nodes,
      edges: [],
    },
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 0.25,
    },
  });

  assert.equal(analysis.candidates.length, 0);
  assert.equal(analysis.summary.endpoints, 2_000);
  assert.ok(
    analysis.summary.neighborChecks < 20_000,
    `expected fewer than 20,000 checks, got ${
      analysis.summary.neighborChecks
    }`,
  );
});

test("queries nearby polyline segments instead of scanning the full edge", () => {
  const geometry = Array.from(
    { length: 2_001 },
    (_, index) => [index, 0],
  );
  const analysis = analyzeGaps({
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "segment-index-smoke",
      revision: "r1",
      space: { dimensions: 2, unit: "m", frame: "local" },
      nodes: [
        { id: "a", position: [0, 0] },
        { id: "b", position: [2_000, 0] },
        { id: "probe", position: [1_000.5, 0.5] },
      ],
      edges: [{
        id: "line",
        from: "a",
        to: "b",
        geometry,
      }],
    },
    proposal: { maxGapDistance: 1 },
  });

  assert.ok(analysis.summary.neighborChecks < 100);
  assert.equal(analysis.candidates.length, 1);
  assert.deepEqual(analysis.candidates[0].operation, {
    kind: "attach-node-to-edge",
    fromNodeId: "probe",
    toEdgeId: "line",
    edgeFromNodeId: "a",
    edgeToNodeId: "b",
    edgeSegmentIndex: 1_000,
    segmentFraction: 0.5,
    distanceAlong: 1_000.5,
  });
  assert.equal(analysis.candidates[0].features.distance, 0.5);
});
