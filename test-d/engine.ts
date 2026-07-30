import {
  GapAnalysisEngine,
  GapEngineLimitError,
  analyzeGaps,
  createGapEngine,
  type EngineEdge,
  type GapAnalysis,
  type GapCandidate,
  type GapEngineInput,
  type NetworkSnapshot,
} from "gap-tolerant-router/engine";

type MixedDimensionalSnapshot = {
  schema: "gtr.network/v1";
  networkId: string;
  revision: string;
  space: {
    dimensions: 2;
    unit: string;
    frame: string;
  };
  nodes: readonly [{
    id: string;
    position: readonly [number, number, number];
  }];
  edges: readonly [];
};
type MixedDimensionsAccepted =
  MixedDimensionalSnapshot extends NetworkSnapshot ? true : false;
const mixedDimensionsRejected: false =
  false as MixedDimensionsAccepted;
void mixedDimensionsRejected;

type MixedGeometryEdge = {
  id: string;
  from: string;
  to: string;
  geometry: readonly [
    readonly [number, number],
    readonly [number, number, number],
  ];
};
type MixedGeometryAccepted =
  MixedGeometryEdge extends EngineEdge ? true : false;
const mixedGeometryRejected: false =
  false as MixedGeometryAccepted;
void mixedGeometryRejected;

type MixedCandidateGeometryAccepted =
  readonly [
    readonly [number, number],
    readonly [number, number, number],
  ] extends GapCandidate["geometry"] ? true : false;
const mixedCandidateGeometryRejected: false =
  false as MixedCandidateGeometryAccepted;
void mixedCandidateGeometryRejected;

const snapshot: NetworkSnapshot<3> = {
  schema: "gtr.network/v1",
  networkId: "typed-network",
  revision: "r1",
  space: {
    dimensions: 3,
    unit: "um",
    frame: "specimen",
  },
  nodes: [
    { id: "a", position: [0, 0, 0] },
    { id: "b", position: [1, 0, 0] },
  ],
  edges: [],
};

const input: GapEngineInput<3> = {
  snapshot,
  proposal: {
    includeEndpointToEdge: true,
    maxCandidatesPerEndpoint: 4,
    maxGapDistance: 2,
    requireDifferentComponents: true,
    requireTangentEvidence: true,
  },
  constraints: {
    forbiddenNodePairs: [["a", "b"]],
  },
  limits: {
    maxCandidatesTotal: 100,
    maxConstraintPairs: 100,
    maxEdges: 100,
    maxNeighborChecks: 1_000,
    maxNodes: 100,
    maxOutputBytes: 100_000,
    maxPropertyBytes: 10_000,
    maxPropertyFields: 100,
    maxStringBytes: 10_000,
    maxTotalPoints: 1_000,
  },
};

const engine: GapAnalysisEngine<3> = createGapEngine(input);
const analysis: GapAnalysis<3> = engine.analyze();
const equivalent: GapAnalysis<3> = analyzeGaps(input);
const candidate: GapCandidate<3> | undefined = analysis.candidates[0];

if (candidate?.operation.kind === "attach-node-to-edge") {
  const edgeId: string = candidate.operation.toEdgeId;
  void edgeId;
}
if (candidate?.operation.kind === "connect-nodes") {
  const targetNode: string = candidate.operation.toNodeId;
  void targetNode;
}
void equivalent;

// @ts-expect-error analysis results are immutable
analysis.selection.omitted = 0;

try {
  throw new GapEngineLimitError(
    "MAX_NODES",
    "input",
    1,
    2,
  );
} catch (error) {
  if (error instanceof GapEngineLimitError) {
    const actual: number = error.actual;
    void actual;
  }
}

// @ts-expect-error a 3D snapshot requires three coordinates
snapshot.nodes[0].position = [0, 0];
