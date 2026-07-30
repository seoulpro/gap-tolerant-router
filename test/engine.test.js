import assert from "node:assert/strict";
import test from "node:test";

import {
  GapAnalysisEngine,
  GapEngineLimitError,
  analyzeGaps,
  createGapEngine,
} from "../src/engine.js";

const snapshot2d = () => ({
  schema: "gtr.network/v1",
  networkId: "two-lines",
  revision: "r1",
  space: {
    dimensions: 2,
    unit: "m",
    frame: "local",
  },
  nodes: [
    { id: "a", position: [0, 0] },
    { id: "b", position: [10, 0] },
    { id: "c", position: [12, 0] },
    { id: "d", position: [22, 0] },
  ],
  edges: [
    {
      id: "left",
      from: "a",
      to: "b",
      geometry: [[0, 0], [10, 0]],
    },
    {
      id: "right",
      from: "c",
      to: "d",
      geometry: [[12, 0], [22, 0]],
    },
  ],
});

test("proposes a review-only endpoint connection with tangent evidence", () => {
  const analysis = analyzeGaps({
    snapshot: snapshot2d(),
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 3,
    },
  });

  assert.equal(analysis.schema, "gtr.analysis/v1");
  assert.equal(analysis.executionComplete, true);
  assert.deepEqual(analysis.selection, {
    policy: "per-endpoint-union",
    truncated: false,
    omitted: 0,
    maxCandidatesPerEndpoint: 8,
  });
  assert.equal(analysis.candidates.length, 1);
  const [candidate] = analysis.candidates;
  assert.deepEqual(candidate.operation, {
    kind: "connect-nodes",
    fromNodeId: "b",
    toNodeId: "c",
    direction: "unspecified",
  });
  assert.equal(candidate.features.distance, 2);
  assert.equal(candidate.features.sourceTangentAlignment, 1);
  assert.equal(candidate.features.targetTangentAlignment, 1);
  assert.deepEqual(candidate.assessment, {
    status: "review",
    reasonCodes: ["HUMAN_REVIEW_REQUIRED"],
    constraintResults: [
      { id: "different-components", result: "pass" },
      { id: "forbidden-connection", result: "pass" },
      { id: "tangent-evidence", result: "pass" },
    ],
  });
  assert.equal(Object.hasOwn(candidate, "confidence"), false);
  assert.equal(Object.hasOwn(candidate, "probability"), false);
  assert.match(candidate.id, /^[a-f0-9]{64}$/);
  assert.match(analysis.digest, /^[a-f0-9]{64}$/);
});

test("supports 3D endpoint-to-edge proposals without flattening coordinates", () => {
  const analysis = analyzeGaps({
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "three-dimensional",
      revision: "r1",
      space: {
        dimensions: 3,
        unit: "um",
        frame: "specimen",
      },
      nodes: [
        { id: "a", position: [0, 0, 0] },
        { id: "b", position: [5, 0, 0] },
        { id: "c", position: [7, -5, 0] },
        { id: "d", position: [7, 5, 0] },
      ],
      edges: [
        {
          id: "source",
          from: "a",
          to: "b",
          geometry: [[0, 0, 0], [5, 0, 0]],
        },
        {
          id: "target",
          from: "c",
          to: "d",
          geometry: [[7, -5, 0], [7, 5, 0]],
        },
      ],
    },
    proposal: {
      maxGapDistance: 2,
      maxCandidatesPerEndpoint: 4,
    },
  });

  const candidate = analysis.candidates.find(
    ({ operation }) => (
      operation.kind === "attach-node-to-edge"
      && operation.fromNodeId === "b"
      && operation.toEdgeId === "target"
    ),
  );
  assert.ok(candidate);
  assert.deepEqual(candidate.geometry, [[5, 0, 0], [7, 0, 0]]);
  assert.equal(candidate.features.distance, 2);
  assert.equal(candidate.features.sourceTangentAlignment, 1);
  assert.equal(candidate.features.targetEdgeTangentAlignment, 0);
  assert.equal(candidate.assessment.status, "review");
  assert.equal(analysis.network.dimensions, 3);
});

test("rejects same-component and explicitly forbidden proposals", () => {
  const sameComponent = analyzeGaps({
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "loop-like",
      revision: "r1",
      space: { dimensions: 2, unit: "m", frame: "local" },
      nodes: [
        { id: "a", position: [0, 0] },
        { id: "b", position: [10, 0] },
        { id: "c", position: [10, 1] },
        { id: "d", position: [0, 1] },
      ],
      edges: [
        { id: "ab", from: "a", to: "b", geometry: [[0, 0], [10, 0]] },
        { id: "bc", from: "b", to: "c", geometry: [[10, 0], [10, 1]] },
        { id: "cd", from: "c", to: "d", geometry: [[10, 1], [0, 1]] },
      ],
    },
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 2,
    },
  });
  assert.equal(sameComponent.candidates.length, 1);
  assert.equal(sameComponent.candidates[0].assessment.status, "reject");
  assert.deepEqual(
    sameComponent.candidates[0].assessment.reasonCodes,
    ["SAME_COMPONENT"],
  );

  const forbidden = analyzeGaps({
    snapshot: snapshot2d(),
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 3,
    },
    constraints: {
      forbiddenNodePairs: [["c", "b"]],
    },
  });
  assert.equal(forbidden.candidates[0].assessment.status, "reject");
  assert.deepEqual(
    forbidden.candidates[0].assessment.reasonCodes,
    ["FORBIDDEN_CONNECTION"],
  );
});

test("ranks actionable candidates before per-endpoint rejected candidates", () => {
  const analysis = analyzeGaps({
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "quota",
      revision: "r1",
      space: { dimensions: 2, unit: "m", frame: "local" },
      nodes: [
        { id: "a", position: [0, 0] },
        { id: "b", position: [1, 0] },
        { id: "c", position: [-2, 0] },
      ],
      edges: [],
    },
    proposal: {
      includeEndpointToEdge: false,
      maxCandidatesPerEndpoint: 1,
      maxGapDistance: 2,
      requireTangentEvidence: false,
    },
    constraints: {
      forbiddenNodePairs: [["a", "b"]],
    },
  });

  assert.equal(analysis.candidates.length, 2);
  assert.deepEqual(analysis.candidates[0].operation, {
    kind: "connect-nodes",
    fromNodeId: "a",
    toNodeId: "c",
    direction: "unspecified",
  });
  assert.equal(analysis.candidates[0].assessment.status, "review");
  assert.equal(analysis.candidates[1].assessment.status, "reject");
  assert.deepEqual(analysis.selection, {
    policy: "per-endpoint-union",
    truncated: false,
    omitted: 0,
    maxCandidatesPerEndpoint: 1,
  });
});

test("keeps forbidden-pair identities collision-free for arbitrary ids", () => {
  const analysis = analyzeGaps({
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "pair-identity",
      revision: "r1",
      space: { dimensions: 2, unit: "m", frame: "local" },
      nodes: [
        { id: "a", position: [100, 0] },
        { id: "b\u0000c", position: [200, 0] },
        { id: "a\u0000b", position: [0, 0] },
        { id: "c", position: [1, 0] },
      ],
      edges: [],
    },
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 2,
      requireTangentEvidence: false,
    },
    constraints: {
      forbiddenNodePairs: [["a", "b\u0000c"]],
    },
  });

  assert.equal(analysis.candidates.length, 1);
  assert.equal(analysis.candidates[0].assessment.status, "review");
  assert.equal(analysis.candidates[0].operation.fromNodeId, "a\u0000b");
  assert.equal(analysis.candidates[0].operation.toNodeId, "c");
});

test("keeps lone surrogates distinct in network and candidate digests", () => {
  const specialIds = ["\ud800", "\udc00", "\ufffd"];
  const analyses = specialIds.map((id) => analyzeGaps({
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "unicode-identifiers",
      revision: "r1",
      space: { dimensions: 2, unit: "m", frame: "local" },
      nodes: [
        { id, position: [0, 0] },
        { id: "target", position: [1, 0] },
      ],
      edges: [],
    },
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 1,
      requireTangentEvidence: false,
    },
  }));

  assert.equal(
    new Set(analyses.map((analysis) => analysis.network.digest)).size,
    specialIds.length,
  );
  assert.equal(
    new Set(analyses.map((analysis) => analysis.configurationDigest)).size,
    specialIds.length,
  );
  assert.equal(
    new Set(analyses.map((analysis) => analysis.candidates[0].id)).size,
    specialIds.length,
  );
});

test("canonicalizes reversed and duplicate constraints", () => {
  const base = {
    snapshot: snapshot2d(),
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 3,
    },
  };
  const canonical = analyzeGaps({
    ...base,
    constraints: { forbiddenNodePairs: [["b", "c"]] },
  });
  const repeated = analyzeGaps({
    ...base,
    constraints: {
      forbiddenNodePairs: [["c", "b"], ["b", "c"]],
    },
  });

  assert.deepEqual(repeated, canonical);
});

test("abstains when isolated endpoints have no tangent evidence", () => {
  const analysis = analyzeGaps({
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "isolated",
      revision: "r1",
      space: { dimensions: 2, unit: "m", frame: "local" },
      nodes: [
        { id: "a", position: [0, 0] },
        { id: "b", position: [1, 0] },
      ],
      edges: [],
    },
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 2,
    },
  });

  assert.equal(analysis.candidates.length, 1);
  assert.equal(analysis.candidates[0].assessment.status, "abstain");
  assert.deepEqual(
    analysis.candidates[0].assessment.reasonCodes,
    ["TANGENT_EVIDENCE_UNAVAILABLE"],
  );
});

test("copies input and produces identical digests across input order", () => {
  const firstSnapshot = snapshot2d();
  const engine = createGapEngine({
    snapshot: firstSnapshot,
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 3,
    },
  });
  firstSnapshot.nodes[1].position[0] = 1_000;
  firstSnapshot.edges[0].geometry[1][0] = 1_000;
  const first = engine.analyze();

  const shuffled = snapshot2d();
  shuffled.nodes.reverse();
  shuffled.edges.reverse();
  const second = analyzeGaps({
    snapshot: shuffled,
    proposal: {
      maxGapDistance: 3,
      includeEndpointToEdge: false,
    },
  });

  assert.deepEqual(second, first);
  assert.equal(engine.analyze(), first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.candidates), true);
  assert.equal(Object.isFrozen(first.candidates[0].geometry[0]), true);

  const differentExecutionProfile = analyzeGaps({
    snapshot: snapshot2d(),
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 3,
    },
    limits: {
      maxCandidatesTotal: 10,
      maxConstraintPairs: 10,
      maxEdges: 10,
      maxNeighborChecks: 100,
      maxNodes: 10,
      maxPropertyBytes: 1_000,
      maxStringBytes: 1_000,
      maxTotalPoints: 100,
    },
  });
  assert.equal(
    differentExecutionProfile.configurationDigest,
    first.configurationDigest,
  );
  assert.equal(
    differentExecutionProfile.candidates[0].id,
    first.candidates[0].id,
  );
  assert.notEqual(
    differentExecutionProfile.executionProfileDigest,
    first.executionProfileDigest,
  );

  const differentAssessmentPolicy = analyzeGaps({
    snapshot: snapshot2d(),
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 3,
      requireTangentEvidence: false,
    },
    constraints: {
      forbiddenNodePairs: [["a", "d"]],
    },
  });
  assert.notEqual(
    differentAssessmentPolicy.configurationDigest,
    first.configurationDigest,
  );
  assert.equal(
    differentAssessmentPolicy.candidates[0].id,
    first.candidates[0].id,
  );
});

test("enforces deterministic work limits with non-sensitive errors", () => {
  assert.throws(
    () => new GapAnalysisEngine({
      snapshot: snapshot2d(),
      limits: { maxNodes: 3 },
    }),
    (error) => {
      assert.ok(error instanceof GapEngineLimitError);
      assert.deepEqual(
        [error.code, error.phase, error.limit, error.actual],
        ["MAX_NODES", "input", 3, 4],
      );
      assert.equal(error.message.includes("two-lines"), false);
      return true;
    },
  );

  const propertyHeavy = snapshot2d();
  propertyHeavy.nodes[0].properties = { label: "private-value" };
  assert.throws(
    () => new GapAnalysisEngine({
      snapshot: propertyHeavy,
      limits: { maxPropertyBytes: 1 },
    }),
    (error) => (
      error instanceof GapEngineLimitError
      && error.code === "MAX_PROPERTY_BYTES"
      && error.message.includes("private-value") === false
    ),
  );

  const propertyWide = snapshot2d();
  propertyWide.nodes[0].properties = { first: 1, second: 2 };
  assert.throws(
    () => new GapAnalysisEngine({
      snapshot: propertyWide,
      limits: { maxPropertyFields: 1 },
    }),
    (error) => (
      error instanceof GapEngineLimitError
      && error.code === "MAX_PROPERTY_FIELDS"
      && error.actual === 2
    ),
  );

  assert.throws(
    () => new GapAnalysisEngine({
      snapshot: snapshot2d(),
      constraints: {
        forbiddenNodePairs: [["b", "c"], ["b", "c"]],
      },
      limits: { maxConstraintPairs: 1 },
    }),
    (error) => (
      error instanceof GapEngineLimitError
      && error.code === "MAX_CONSTRAINT_PAIRS"
      && error.actual === 2
    ),
  );

  assert.doesNotThrow(
    () => new GapAnalysisEngine({
      snapshot: snapshot2d(),
      constraints: { forbiddenNodePairs: [["b", "c"]] },
      limits: { maxStringBytes: 36 },
    }),
  );
  assert.throws(
    () => new GapAnalysisEngine({
      snapshot: snapshot2d(),
      constraints: {
        forbiddenNodePairs: [["b", "c"], ["b", "c"]],
      },
      limits: { maxStringBytes: 36 },
    }),
    (error) => (
      error instanceof GapEngineLimitError
      && error.code === "MAX_STRING_BYTES"
      && error.message.includes("b") === false
    ),
  );

  const longIdentifier = snapshot2d();
  longIdentifier.nodes[0].id = "sensitive-id";
  longIdentifier.edges[0].from = "sensitive-id";
  assert.throws(
    () => new GapAnalysisEngine({
      snapshot: longIdentifier,
      limits: { maxStringBytes: 1 },
    }),
    (error) => (
      error instanceof GapEngineLimitError
      && error.code === "MAX_STRING_BYTES"
      && error.message.includes("sensitive-id") === false
    ),
  );

  const neighborLimited = new GapAnalysisEngine({
    snapshot: snapshot2d(),
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 3,
    },
    limits: { maxNeighborChecks: 0 },
  });
  assert.throws(
    () => neighborLimited.analyze(),
    (error) => {
      assert.ok(error instanceof GapEngineLimitError);
      assert.equal(error.code, "MAX_NEIGHBOR_CHECKS");
      assert.equal(error.actual, 1);
      return true;
    },
  );

  const candidateLimited = new GapAnalysisEngine({
    snapshot: snapshot2d(),
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 3,
    },
    limits: { maxCandidatesTotal: 0 },
  });
  assert.throws(
    () => candidateLimited.analyze(),
    (error) => (
      error instanceof GapEngineLimitError
      && error.code === "MAX_CANDIDATES_TOTAL"
    ),
  );

  const baselineOutput = analyzeGaps({
    snapshot: snapshot2d(),
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 3,
    },
  });
  const outputBytes = Buffer.byteLength(
    JSON.stringify(baselineOutput),
    "utf8",
  );
  const exactOutput = analyzeGaps({
    snapshot: snapshot2d(),
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 3,
    },
    limits: { maxOutputBytes: outputBytes },
  });
  assert.equal(
    Buffer.byteLength(JSON.stringify(exactOutput), "utf8"),
    outputBytes,
  );
  const outputLimited = new GapAnalysisEngine({
    snapshot: snapshot2d(),
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 3,
    },
    limits: { maxOutputBytes: outputBytes - 1 },
  });
  assert.throws(
    () => outputLimited.analyze(),
    (error) => (
      error instanceof GapEngineLimitError
      && error.code === "MAX_OUTPUT_BYTES"
      && error.phase === "output"
      && error.actual === outputBytes
      && error.message.includes("two-lines") === false
    ),
  );

  const longPolyline = {
    schema: "gtr.network/v1",
    networkId: "projection-budget",
    revision: "r1",
    space: { dimensions: 2, unit: "m", frame: "local" },
    nodes: [
      { id: "a", position: [0, 0] },
      { id: "b", position: [3, 0] },
      { id: "s", position: [1.5, 1] },
    ],
    edges: [{
      id: "target",
      from: "a",
      to: "b",
      geometry: [[0, 0], [1, 0], [2, 0], [3, 0]],
    }],
  };
  const projectionLimited = new GapAnalysisEngine({
    snapshot: longPolyline,
    proposal: { maxGapDistance: 2 },
    limits: { maxNeighborChecks: 6 },
  });
  assert.throws(
    () => projectionLimited.analyze(),
    (error) => (
      error instanceof GapEngineLimitError
      && error.code === "MAX_NEIGHBOR_CHECKS"
      && error.actual === 7
    ),
  );
});

test("rejects ambiguous schemas, malformed geometry, and unsafe properties", () => {
  const wrongDimension = snapshot2d();
  wrongDimension.space.dimensions = 4;
  assert.throws(
    () => createGapEngine({ snapshot: wrongDimension }),
    /space dimensions must be 2 or 3/,
  );

  const mismatched = snapshot2d();
  mismatched.edges[0].geometry[0] = [1, 0];
  assert.throws(
    () => createGapEngine({ snapshot: mismatched }),
    /geometry endpoints must exactly match/,
  );

  const overflowing = snapshot2d();
  overflowing.nodes[0].position = [-1e308, 0];
  overflowing.nodes[1].position = [1e308, 0];
  overflowing.edges[0].geometry = [[-1e308, 0], [1e308, 0]];
  assert.throws(
    () => createGapEngine({ snapshot: overflowing }),
    /coordinate differences must remain finite/,
  );

  const withAccessor = snapshot2d();
  withAccessor.nodes[0].properties = {};
  Object.defineProperty(withAccessor.nodes[0].properties, "secret", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  assert.throws(
    () => createGapEngine({ snapshot: withAccessor }),
    /must not contain accessors/,
  );

  assert.throws(
    () => createGapEngine({
      snapshot: snapshot2d(),
      proposal: { unexpected: true },
    }),
    /unknown proposal field/,
  );

  const tooManyFields = snapshot2d();
  for (let index = 0; index < 65; index += 1) {
    tooManyFields.nodes[0][`extra-${index}`] = index;
  }
  assert.throws(
    () => createGapEngine({ snapshot: tooManyFields }),
    /node 0 contains too many fields/,
  );
});

test("validates the complete engine input boundary", () => {
  const withUndefinedOptionals = analyzeGaps({
    snapshot: snapshot2d(),
    proposal: {
      includeEndpointToEdge: undefined,
      maxGapDistance: undefined,
    },
    limits: { maxNodes: undefined },
  });
  assert.equal(withUndefinedOptionals.candidates.length, 0);

  assert.throws(
    () => createGapEngine(null),
    /engine input must be a plain object/,
  );
  assert.throws(
    () => createGapEngine({ snapshot: snapshot2d(), unexpected: true }),
    /unknown engine input field/,
  );
  assert.throws(
    () => createGapEngine({
      snapshot: snapshot2d(),
      limits: { maxNodes: -1 },
    }),
    /maxNodes must be a non-negative safe integer/,
  );
  assert.throws(
    () => createGapEngine({
      snapshot: snapshot2d(),
      limits: { unexpected: 1 },
    }),
    /unknown limit field/,
  );

  const oversizedPair = new Array(1_000_000);
  assert.throws(
    () => createGapEngine({
      snapshot: snapshot2d(),
      constraints: { forbiddenNodePairs: [oversizedPair] },
      limits: {
        maxConstraintPairs: 1,
        maxStringBytes: 100,
      },
    }),
    /forbiddenNodePairs must be an array of id pairs/,
  );

  const oversizedUnknownField = `private-${"x".repeat(100_000)}`;
  const inputWithUnknownField = Object.assign(Object.create(null), {
    snapshot: snapshot2d(),
    [oversizedUnknownField]: true,
  });
  assert.throws(
    () => createGapEngine(inputWithUnknownField),
    (error) => (
      error instanceof TypeError
      && error.message === "unknown engine input field"
      && !error.message.includes(oversizedUnknownField)
    ),
  );

  assert.throws(
    () => createGapEngine({
      snapshot: snapshot2d(),
      proposal: { maxGapDistance: -1 },
    }),
    /maxGapDistance must be a finite non-negative number/,
  );
  assert.throws(
    () => createGapEngine({
      snapshot: snapshot2d(),
      proposal: { includeEndpointToEdge: "yes" },
    }),
    /includeEndpointToEdge must be a boolean/,
  );

  const wrongSchema = snapshot2d();
  wrongSchema.schema = "gtr.network/v2";
  assert.throws(
    () => createGapEngine({ snapshot: wrongSchema }),
    /snapshot schema must be gtr.network\/v1/,
  );

  const emptyNetworkId = snapshot2d();
  emptyNetworkId.networkId = "";
  assert.throws(
    () => createGapEngine({ snapshot: emptyNetworkId }),
    /networkId must be a non-empty string/,
  );

  const wrongMetric = snapshot2d();
  wrongMetric.space.metric = "manhattan";
  assert.throws(
    () => createGapEngine({ snapshot: wrongMetric }),
    /space metric must be euclidean/,
  );

  const nodesNotArray = snapshot2d();
  nodesNotArray.nodes = {};
  assert.throws(
    () => createGapEngine({ snapshot: nodesNotArray }),
    /snapshot nodes must be an array/,
  );

  const edgesNotArray = snapshot2d();
  edgesNotArray.edges = {};
  assert.throws(
    () => createGapEngine({ snapshot: edgesNotArray }),
    /snapshot edges must be an array/,
  );

  const duplicateNode = snapshot2d();
  duplicateNode.nodes[1].id = "a";
  assert.throws(
    () => createGapEngine({ snapshot: duplicateNode }),
    /node ids must be unique/,
  );

  const invalidPosition = snapshot2d();
  invalidPosition.nodes[0].position = [0];
  assert.throws(
    () => createGapEngine({ snapshot: invalidPosition }),
    /must be a 2-dimensional numeric tuple/,
  );

  const invalidProperty = snapshot2d();
  invalidProperty.nodes[0].properties = { nested: {} };
  assert.throws(
    () => createGapEngine({ snapshot: invalidProperty }),
    /values must be JSON scalar values/,
  );

  const forbiddenProperty = snapshot2d();
  forbiddenProperty.nodes[0].properties = {};
  Object.defineProperty(forbiddenProperty.nodes[0].properties, "__proto__", {
    enumerable: true,
    value: "unsafe",
  });
  assert.throws(
    () => createGapEngine({ snapshot: forbiddenProperty }),
    /contains a forbidden property key/,
  );

  const duplicateEdge = snapshot2d();
  duplicateEdge.edges[1].id = "left";
  assert.throws(
    () => createGapEngine({ snapshot: duplicateEdge }),
    /edge ids must be unique/,
  );

  const unknownEndpoint = snapshot2d();
  unknownEndpoint.edges[0].from = "missing";
  assert.throws(
    () => createGapEngine({ snapshot: unknownEndpoint }),
    /edges must reference known node ids/,
  );

  const shortGeometry = snapshot2d();
  shortGeometry.edges[0].geometry = [[0, 0]];
  assert.throws(
    () => createGapEngine({ snapshot: shortGeometry }),
    /edge geometry must contain at least two points/,
  );

  const zeroGeometry = snapshot2d();
  zeroGeometry.nodes[1].position = [0, 0];
  zeroGeometry.edges[0].geometry = [[0, 0], [0, 0]];
  assert.throws(
    () => createGapEngine({ snapshot: zeroGeometry }),
    /edge geometry must have positive length/,
  );

  const wrongDirection = snapshot2d();
  wrongDirection.edges[0].direction = "sideways";
  assert.throws(
    () => createGapEngine({ snapshot: wrongDirection }),
    /edge direction must be both, forward, or reverse/,
  );

  assert.throws(
    () => createGapEngine({
      snapshot: snapshot2d(),
      constraints: { forbiddenNodePairs: "b,c" },
    }),
    /forbiddenNodePairs must be an array of id pairs/,
  );
  assert.throws(
    () => createGapEngine({
      snapshot: snapshot2d(),
      constraints: { forbiddenNodeEdgePairs: [["missing", "left"]] },
    }),
    /forbiddenNodeEdgePairs must reference known string ids/,
  );

  assert.throws(
    () => createGapEngine({
      snapshot: snapshot2d(),
      limits: { maxEdges: 1 },
    }),
    (error) => (
      error instanceof GapEngineLimitError
      && error.code === "MAX_EDGES"
    ),
  );
  assert.throws(
    () => createGapEngine({
      snapshot: snapshot2d(),
      limits: { maxTotalPoints: 3 },
    }),
    (error) => (
      error instanceof GapEngineLimitError
      && error.code === "MAX_TOTAL_POINTS"
    ),
  );
});

test("applies endpoint-to-edge safety constraints without authorizing a link", () => {
  const analysis = analyzeGaps({
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "forbidden-edge-attachment",
      revision: "r1",
      space: { dimensions: 2, unit: "m", frame: "local" },
      nodes: [
        { id: "a", position: [0, 0] },
        { id: "b", position: [2, 0] },
        { id: "c", position: [4, -2] },
        { id: "d", position: [4, 2] },
      ],
      edges: [
        { id: "source", from: "a", to: "b", geometry: [[0, 0], [2, 0]] },
        { id: "target", from: "c", to: "d", geometry: [[4, -2], [4, 2]] },
      ],
    },
    proposal: { maxGapDistance: 2 },
    constraints: {
      forbiddenNodeEdgePairs: [["b", "target"]],
    },
  });

  const candidate = analysis.candidates.find(
    ({ operation }) => (
      operation.kind === "attach-node-to-edge"
      && operation.fromNodeId === "b"
      && operation.toEdgeId === "target"
    ),
  );
  assert.ok(candidate);
  assert.equal(candidate.assessment.status, "reject");
  assert.ok(
    candidate.assessment.reasonCodes.includes("FORBIDDEN_CONNECTION"),
  );
});

test("does not execute inherited or array accessors while normalizing input", () => {
  const missingRevision = snapshot2d();
  delete missingRevision.revision;
  let inheritedGetterRan = false;
  Object.defineProperty(Object.prototype, "revision", {
    configurable: true,
    get() {
      inheritedGetterRan = true;
      throw new Error("must not execute");
    },
  });
  try {
    assert.throws(
      () => createGapEngine({ snapshot: missingRevision }),
      /revision must be a non-empty string/,
    );
    assert.equal(inheritedGetterRan, false);
  } finally {
    delete Object.prototype.revision;
  }

  const indexedAccessor = snapshot2d();
  let indexGetterRan = false;
  Object.defineProperty(indexedAccessor.nodes, "0", {
    configurable: true,
    enumerable: true,
    get() {
      indexGetterRan = true;
      throw new Error("must not execute");
    },
  });
  assert.throws(
    () => createGapEngine({ snapshot: indexedAccessor }),
    /dense array of data elements/,
  );
  assert.equal(indexGetterRan, false);

  const preflightLimited = snapshot2d();
  let limitedIndexGetterRan = false;
  Object.defineProperty(preflightLimited.nodes, "0", {
    configurable: true,
    enumerable: true,
    get() {
      limitedIndexGetterRan = true;
      throw new Error("must not execute");
    },
  });
  assert.throws(
    () => createGapEngine({
      snapshot: preflightLimited,
      limits: { maxNodes: 3 },
    }),
    (error) => (
      error instanceof GapEngineLimitError
      && error.code === "MAX_NODES"
    ),
  );
  assert.equal(limitedIndexGetterRan, false);

  const proxied = new Proxy(snapshot2d(), {});
  assert.throws(
    () => createGapEngine({ snapshot: proxied }),
    /snapshot must be a plain object/,
  );

  const nestedProxy = snapshot2d();
  let nestedProxyRead = false;
  nestedProxy.nodes = new Proxy(nestedProxy.nodes, {
    get(target, property, receiver) {
      nestedProxyRead = true;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () => createGapEngine({ snapshot: nestedProxy }),
    /snapshot nodes must be an array/,
  );
  assert.equal(nestedProxyRead, false);

  const constraintProxy = new Proxy([["b", "c"]], {
    get(target, property, receiver) {
      nestedProxyRead = true;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () => createGapEngine({
      snapshot: snapshot2d(),
      constraints: { forbiddenNodePairs: constraintProxy },
    }),
    /forbiddenNodePairs must be an array/,
  );
  assert.equal(nestedProxyRead, false);
});

test("counts escaped property bytes before copying oversized values", () => {
  const exact = snapshot2d();
  exact.nodes[0].properties = { quote: "\"" };
  assert.doesNotThrow(
    () => createGapEngine({
      snapshot: exact,
      limits: { maxPropertyBytes: 14 },
    }),
  );

  const over = snapshot2d();
  over.nodes[0].properties = { quote: "\"" };
  assert.throws(
    () => createGapEngine({
      snapshot: over,
      limits: { maxPropertyBytes: 13 },
    }),
    (error) => (
      error instanceof GapEngineLimitError
      && error.code === "MAX_PROPERTY_BYTES"
      && error.actual === 14
    ),
  );

  const large = snapshot2d();
  large.nodes[0].properties = { value: "x".repeat(100_000) };
  assert.throws(
    () => createGapEngine({
      snapshot: large,
      limits: { maxPropertyBytes: 32 },
    }),
    (error) => (
      error instanceof GapEngineLimitError
      && error.code === "MAX_PROPERTY_BYTES"
      && error.actual <= 38
    ),
  );
});

test("keeps projection ranking raw and endpoint classification consistent", () => {
  const nearestSegment = analyzeGaps({
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "near-rounding-projection",
      revision: "r1",
      space: { dimensions: 2, unit: "m", frame: "local" },
      nodes: [
        { id: "edge-a", position: [1.000000000000006, -1] },
        { id: "edge-b", position: [1.000000000000008, -1] },
        { id: "probe", position: [0, 0] },
      ],
      edges: [{
        id: "folded-edge",
        from: "edge-a",
        to: "edge-b",
        geometry: [
          [1.000000000000006, -1],
          [1.000000000000006, 1],
          [1.000000000000008, 1],
          [1.000000000000008, -1],
        ],
      }],
    },
    proposal: { maxGapDistance: 2 },
  });
  const projection = nearestSegment.candidates.find(
    ({ operation }) => (
      operation.kind === "attach-node-to-edge"
      && operation.fromNodeId === "probe"
    ),
  );
  assert.ok(projection);
  assert.equal(projection.operation.edgeSegmentIndex, 0);
  assert.equal(projection.operation.segmentFraction, 0.5);

  const endpointCollapse = analyzeGaps({
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "endpoint-collapse",
      revision: "r1",
      space: { dimensions: 2, unit: "m", frame: "local" },
      nodes: [
        { id: "a", position: [0, 0] },
        { id: "b", position: [1, 1] },
        { id: "probe", position: [1, 1] },
      ],
      edges: [{
        id: "diagonal",
        from: "a",
        to: "b",
        geometry: [[0, 0], [1, 1]],
      }],
    },
    proposal: { maxGapDistance: 2 },
  });
  assert.equal(
    endpointCollapse.candidates.some(
      ({ operation }) => operation.kind === "attach-node-to-edge",
    ),
    false,
  );
});

const analyzeProjectionCase = ({
  start,
  end,
  probe,
  maxGapDistance,
  geometry = [start, end],
}) => analyzeGaps({
  snapshot: {
    schema: "gtr.network/v1",
    networkId: "projection-case",
    revision: "r1",
    space: {
      dimensions: start.length,
      unit: "m",
      frame: "local",
    },
    nodes: [
      { id: "edge-a", position: start },
      { id: "edge-b", position: end },
      { id: "probe", position: probe },
    ],
    edges: [{
      id: "target",
      from: "edge-a",
      to: "edge-b",
      geometry,
    }],
  },
  proposal: {
    maxGapDistance,
    requireTangentEvidence: false,
  },
});

const probeAttachment = (analysis) => analysis.candidates.find(
  ({ operation }) => (
    operation.kind === "attach-node-to-edge"
    && operation.fromNodeId === "probe"
  ),
);

test("keeps exact 2D and 3D collinear projections at zero distance", () => {
  const cases = [
    {
      start: [0, 0],
      end: [1, 6],
      probe: [0.375, 2.25],
      fraction: 0.375,
    },
    {
      start: [0, 0],
      end: [10, 3],
      probe: [8.75, 2.625],
      fraction: 0.875,
    },
    {
      start: [0, 0, 0],
      end: [1, 1, 3],
      probe: [0.375, 0.375, 1.125],
      fraction: 0.375,
    },
  ];

  for (const example of cases) {
    const candidate = probeAttachment(analyzeProjectionCase({
      ...example,
      maxGapDistance: 0,
    }));
    assert.ok(candidate);
    assert.equal(candidate.operation.segmentFraction, example.fraction);
    assert.equal(
      candidate.operation.distanceAlong,
      Math.sqrt(example.probe.reduce(
        (sum, coordinate) => sum + coordinate * coordinate,
        0,
      )),
    );
    assert.deepEqual(candidate.geometry, [example.probe, example.probe]);
    assert.equal(candidate.features.distance, 0);
  }
});

test("projects across tiny, huge, and translated coordinate scales", () => {
  const tiny = probeAttachment(analyzeProjectionCase({
    start: [0, 0],
    end: [1e-300, 0],
    probe: [5e-301, 1e100],
    maxGapDistance: 1e100,
  }));
  assert.ok(tiny);
  assert.equal(tiny.operation.segmentFraction, 0.5);
  assert.equal(tiny.operation.distanceAlong, 5e-301);
  assert.deepEqual(tiny.geometry[1], [5e-301, 0]);
  assert.equal(tiny.features.distance, 1e100);

  const huge = probeAttachment(analyzeProjectionCase({
    start: [0, 0, 0],
    end: [1e300, 1e300, 1e300],
    probe: [5e299, 5e299, 5e299],
    maxGapDistance: 0,
  }));
  assert.ok(huge);
  assert.equal(huge.operation.segmentFraction, 0.5);
  assert.deepEqual(huge.geometry[0], huge.geometry[1]);
  assert.equal(huge.features.distance, 0);

  const translated = probeAttachment(analyzeProjectionCase({
    start: [1e16, 0],
    end: [1e16 + 100, 100],
    probe: [1e16 + 50, 50],
    maxGapDistance: 0,
  }));
  assert.ok(translated);
  assert.equal(translated.operation.segmentFraction, 0.5);
  assert.equal(
    translated.operation.distanceAlong,
    Math.hypot(100, 100) * 0.5,
  );
  assert.deepEqual(translated.geometry[0], translated.geometry[1]);
  assert.equal(translated.features.distance, 0);
});

test("keeps endpoint-to-edge projection independent of edge orientation", () => {
  const forward = probeAttachment(analyzeProjectionCase({
    start: [0, 0],
    end: [1e263, 0],
    probe: [1e262, 0],
    maxGapDistance: 0,
  }));
  const reverse = probeAttachment(analyzeProjectionCase({
    start: [1e263, 0],
    end: [0, 0],
    probe: [1e262, 0],
    maxGapDistance: 0,
  }));

  assert.ok(forward);
  assert.ok(reverse);
  assert.equal(forward.features.distance, 0);
  assert.equal(reverse.features.distance, 0);
  assert.deepEqual(forward.geometry[1], [1e262, 0]);
  assert.deepEqual(reverse.geometry[1], [1e262, 0]);
  assert.equal(forward.operation.segmentFraction, 0.1);
  assert.equal(reverse.operation.segmentFraction, 0.9);
});

test("uses exact interior distances for strict candidate thresholds", () => {
  const falseZeroCases = [
    {
      start: [0, 0],
      end: [Number.MIN_VALUE, Number.MIN_VALUE],
      probe: [Number.MIN_VALUE, 0],
      distance: Number.MIN_VALUE,
    },
    {
      start: [1e16, 1e16],
      end: [1e16 + 4, 1e16 + 8],
      probe: [1e16 + 2, 1e16 + 2],
      distance: Math.sqrt(0.8),
    },
    {
      start: [0, 0],
      end: [1.25, 3],
      probe: [0.875, 2.1],
      distance: 3.416070845000482e-17,
    },
    {
      start: [0, 0],
      end: [1.5, -1],
      probe: [1.35, -0.9],
      distance: 3.079204648066709e-17,
    },
  ];

  for (const example of falseZeroCases) {
    const excluded = probeAttachment(analyzeProjectionCase({
      ...example,
      maxGapDistance: example.distance / 2,
    }));
    assert.equal(excluded, undefined);

    const included = probeAttachment(analyzeProjectionCase({
      ...example,
      maxGapDistance: example.distance,
    }));
    assert.ok(included);
    assert.equal(included.features.distance, example.distance);
  }

  const subnormal = probeAttachment(analyzeProjectionCase({
    ...falseZeroCases[0],
    maxGapDistance: Number.MIN_VALUE,
  }));
  assert.ok(subnormal);
  assert.equal(subnormal.operation.segmentFraction, 0.5);
  assert.equal(subnormal.operation.distanceAlong, Number.MIN_VALUE);
});

test("keeps interior projections under large orthogonal offsets", () => {
  const scale = 2 ** 25;
  const tiedEndpoint = probeAttachment(analyzeProjectionCase({
    start: [0, 0],
    end: [1, 1],
    probe: [scale + 0.5, -scale + 0.5],
    maxGapDistance: Math.hypot(scale, scale),
  }));
  assert.ok(tiedEndpoint);
  assert.equal(tiedEndpoint.operation.segmentFraction, 0.5);

  const endpoint = probeAttachment(analyzeProjectionCase({
    start: [0, 0],
    end: [1, 1],
    probe: [0.5, -(2 ** 52)],
    maxGapDistance: 2 ** 52,
  }));
  assert.equal(endpoint, undefined);

  const strictAxisBias = probeAttachment(analyzeProjectionCase({
    start: [0, 0],
    end: [10, 3],
    probe: [-422212465065980.25, 1407374883553281],
    maxGapDistance: Number.MAX_VALUE,
  }));
  assert.ok(strictAxisBias);
  assert.equal(
    strictAxisBias.operation.segmentFraction,
    40.5 / 109,
  );

  const cancelledDirect = probeAttachment(analyzeProjectionCase({
    start: [0, 0],
    end: [1, 1.5],
    probe: [3377699720527872, -2251799813685247.8],
    maxGapDistance: Number.MAX_VALUE,
  }));
  assert.ok(cancelledDirect);
  assert.ok(cancelledDirect.operation.segmentFraction > 0);
  assert.ok(cancelledDirect.operation.segmentFraction < 1);

  const roundedPastEndpoint = probeAttachment(analyzeProjectionCase({
    start: [0, 0],
    end: [1, 1.25],
    probe: [22517998136852480, -18014398509481982],
    maxGapDistance: Number.MAX_VALUE,
  }));
  assert.ok(roundedPastEndpoint);
  assert.ok(roundedPastEndpoint.operation.segmentFraction > 0);
  assert.ok(roundedPastEndpoint.operation.segmentFraction < 1);

  const nearEndpoint = probeAttachment(analyzeProjectionCase({
    start: [0, 0],
    end: [1, 1.25],
    probe: [-1.5000000000000002, 3.25],
    maxGapDistance: 10,
  }));
  assert.ok(nearEndpoint);
  assert.equal(
    nearEndpoint.operation.segmentFraction,
    0.9999999999999999,
  );

  const narrowCancellation = probeAttachment(analyzeProjectionCase({
    start: [0, 0],
    end: [3, 7],
    probe: [-3940649673949181.5, 1688849860263942],
    maxGapDistance: Number.MAX_VALUE,
  }));
  assert.ok(narrowCancellation);
  assert.equal(
    narrowCancellation.operation.segmentFraction,
    0.853448275862069,
  );
});

test("classifies only global polyline endpoints as edge endpoints", () => {
  const exactEndpoint = probeAttachment(analyzeProjectionCase({
    start: [-1.3125, -1.6875],
    end: [-1.5, -1.5625],
    probe: [-2.3125, -3.1875],
    maxGapDistance: 2,
  }));
  assert.equal(exactEndpoint, undefined);

  const duplicatedEnds = analyzeGaps({
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "duplicated-edge-ends",
      revision: "r1",
      space: { dimensions: 2, unit: "m", frame: "local" },
      nodes: [
        { id: "a", position: [0, 0] },
        { id: "b", position: [10, 0] },
        { id: "probe-a", position: [0, 1] },
        { id: "probe-b", position: [10, 1] },
      ],
      edges: [{
        id: "target",
        from: "a",
        to: "b",
        geometry: [[0, 0], [0, 0], [10, 0], [10, 0]],
      }],
    },
    proposal: {
      maxGapDistance: 2,
      requireTangentEvidence: false,
    },
  });
  assert.equal(
    duplicatedEnds.candidates.some(
      ({ operation }) => operation.kind === "attach-node-to-edge",
    ),
    false,
  );

  const internalDuplicate = probeAttachment(analyzeProjectionCase({
    start: [0, 0],
    end: [10, 0],
    geometry: [[0, 0], [5, 0], [5, 0], [10, 0]],
    probe: [5, 1],
    maxGapDistance: 1,
  }));
  assert.ok(internalDuplicate);
  assert.equal(internalDuplicate.operation.edgeSegmentIndex, 0);
  assert.equal(internalDuplicate.operation.segmentFraction, 1);
  assert.equal(internalDuplicate.operation.distanceAlong, 5);
  assert.deepEqual(internalDuplicate.geometry[1], [5, 0]);
  assert.equal(internalDuplicate.features.distance, 1);
});

test("uses raw distances for exact and next-representable thresholds", () => {
  const outsideNode = analyzeGaps({
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "raw-node-threshold",
      revision: "r1",
      space: { dimensions: 2, unit: "m", frame: "local" },
      nodes: [
        { id: "a", position: [0, 0] },
        { id: "b", position: [1.0000000000000002, 0] },
      ],
      edges: [],
    },
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 1,
      requireTangentEvidence: false,
    },
  });
  assert.equal(outsideNode.candidates.length, 0);

  const outsideEdge = probeAttachment(analyzeProjectionCase({
    start: [-2, 0],
    end: [2, 0],
    probe: [0, 1.0000000000000002],
    maxGapDistance: 1,
  }));
  assert.equal(outsideEdge, undefined);

  const insideDistance = 0.9999999999999997;
  const insideEdge = probeAttachment(analyzeProjectionCase({
    start: [-2, 0],
    end: [2, 0],
    probe: [0, insideDistance],
    maxGapDistance: 0.9999999999999998,
  }));
  assert.ok(insideEdge);
  assert.equal(insideEdge.features.distance, insideDistance);

  const boundary = probeAttachment(analyzeProjectionCase({
    start: [-2, 0],
    end: [2, 0],
    probe: [0, 1],
    maxGapDistance: 1,
  }));
  assert.ok(boundary);
  assert.equal(boundary.features.distance, 1);
});

test("covers junction targets but never proposes an existing direct edge", () => {
  const junction = analyzeGaps({
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "junction-target",
      revision: "r1",
      space: { dimensions: 2, unit: "m", frame: "local" },
      nodes: [
        { id: "branch-source", position: [-2, 0] },
        { id: "branch-tip", position: [0, 0] },
        { id: "junction", position: [0.5, 0] },
        { id: "junction-down", position: [0.5, -1] },
        { id: "junction-up", position: [0.5, 1] },
      ],
      edges: [
        {
          id: "branch",
          from: "branch-source",
          to: "branch-tip",
          geometry: [[-2, 0], [0, 0]],
        },
        {
          id: "lower",
          from: "junction-down",
          to: "junction",
          geometry: [[0.5, -1], [0.5, 0]],
        },
        {
          id: "upper",
          from: "junction",
          to: "junction-up",
          geometry: [[0.5, 0], [0.5, 1]],
        },
      ],
    },
    proposal: {
      includeEndpointToEdge: true,
      maxGapDistance: 0.75,
    },
  });
  assert.equal(junction.candidates.length, 1);
  assert.deepEqual(junction.candidates[0].operation, {
    kind: "connect-nodes",
    fromNodeId: "branch-tip",
    toNodeId: "junction",
    direction: "unspecified",
  });
  assert.equal(junction.candidates[0].assessment.status, "abstain");

  const alreadyConnected = analyzeGaps({
    snapshot: {
      schema: "gtr.network/v1",
      networkId: "direct-edge",
      revision: "r1",
      space: { dimensions: 2, unit: "m", frame: "local" },
      nodes: [
        { id: "a", position: [0, 0] },
        { id: "b", position: [1, 0] },
      ],
      edges: [{
        id: "ab",
        from: "a",
        to: "b",
        geometry: [[0, 0], [1, 0]],
      }],
    },
    proposal: {
      includeEndpointToEdge: false,
      maxGapDistance: 2,
      requireDifferentComponents: false,
    },
  });
  assert.equal(alreadyConnected.candidates.length, 0);
});
