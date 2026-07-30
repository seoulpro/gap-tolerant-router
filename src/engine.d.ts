export type EngineDimension = 2 | 3;

export type EngineVector<D extends EngineDimension = EngineDimension> =
  D extends 2
    ? readonly [number, number]
    : readonly [number, number, number];

export type EnginePropertyValue = string | number | boolean | null;

export interface EngineSpace<D extends EngineDimension = EngineDimension> {
  dimensions: D;
  unit: string;
  frame: string;
  metric?: "euclidean";
}

export interface EngineNode<D extends EngineDimension = EngineDimension> {
  id: string;
  position: EngineVector<D>;
  properties?: Readonly<Record<string, EnginePropertyValue>>;
}

interface EngineEdgeShape<D extends EngineDimension> {
  id: string;
  from: string;
  to: string;
  geometry: readonly EngineVector<D>[];
  direction?: "both" | "forward" | "reverse";
  properties?: Readonly<Record<string, EnginePropertyValue>>;
}

export type EngineEdge<
  D extends EngineDimension = EngineDimension,
> = D extends EngineDimension ? EngineEdgeShape<D> : never;

interface NetworkSnapshotShape<D extends EngineDimension> {
  schema: "gtr.network/v1";
  networkId: string;
  revision: string;
  space: EngineSpace<D>;
  nodes: readonly EngineNode<D>[];
  edges: readonly EngineEdge<D>[];
}

export type NetworkSnapshot<
  D extends EngineDimension = EngineDimension,
> = D extends EngineDimension ? NetworkSnapshotShape<D> : never;

export interface GapProposalOptions {
  maxGapDistance?: number;
  maxCandidatesPerEndpoint?: number;
  includeEndpointToEdge?: boolean;
  requireDifferentComponents?: boolean;
  requireTangentEvidence?: boolean;
}

export interface GapEngineConstraints {
  forbiddenNodePairs?: readonly (readonly [string, string])[];
  forbiddenNodeEdgePairs?: readonly (readonly [string, string])[];
}

export interface GapEngineLimits {
  maxNodes?: number;
  maxEdges?: number;
  maxTotalPoints?: number;
  maxPropertyFields?: number;
  maxPropertyBytes?: number;
  maxStringBytes?: number;
  maxConstraintPairs?: number;
  maxNeighborChecks?: number;
  maxCandidatesTotal?: number;
  maxOutputBytes?: number;
}

export interface GapEngineInput<
  D extends EngineDimension = EngineDimension,
> {
  snapshot: NetworkSnapshot<D>;
  proposal?: GapProposalOptions;
  constraints?: GapEngineConstraints;
  limits?: GapEngineLimits;
}

export type GapEngineLimitCode =
  | "MAX_NODES"
  | "MAX_EDGES"
  | "MAX_TOTAL_POINTS"
  | "MAX_PROPERTY_FIELDS"
  | "MAX_PROPERTY_BYTES"
  | "MAX_STRING_BYTES"
  | "MAX_CONSTRAINT_PAIRS"
  | "MAX_NEIGHBOR_CHECKS"
  | "MAX_CANDIDATES_TOTAL"
  | "MAX_OUTPUT_BYTES";

export type GapEngineLimitPhase =
  | "input"
  | "candidate-generation"
  | "output";

export class GapEngineLimitError extends RangeError {
  constructor(
    code: GapEngineLimitCode,
    phase: GapEngineLimitPhase,
    limit: number,
    actual: number,
  );
  readonly code: GapEngineLimitCode;
  readonly phase: GapEngineLimitPhase;
  readonly limit: number;
  readonly actual: number;
}

export interface ConnectNodesOperation {
  readonly kind: "connect-nodes";
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly direction: "unspecified";
}

export interface AttachNodeToEdgeOperation {
  readonly kind: "attach-node-to-edge";
  readonly fromNodeId: string;
  readonly toEdgeId: string;
  readonly edgeFromNodeId: string;
  readonly edgeToNodeId: string;
  readonly edgeSegmentIndex: number;
  readonly segmentFraction: number;
  readonly distanceAlong: number;
}

export type GapOperation =
  | ConnectNodesOperation
  | AttachNodeToEdgeOperation;

export interface GapCandidateFeatures {
  readonly distance: number;
  readonly sourceTangentAlignment: number | null;
  readonly targetTangentAlignment: number | null;
  readonly targetEdgeTangentAlignment: number | null;
}

export interface GapConstraintResult {
  readonly id:
    | "different-components"
    | "forbidden-connection"
    | "tangent-evidence";
  readonly result: "pass" | "fail" | "unknown";
}

export type GapAssessmentStatus = "review" | "reject" | "abstain";

export interface GapCandidateAssessment {
  readonly status: GapAssessmentStatus;
  readonly reasonCodes: readonly string[];
  readonly constraintResults: readonly GapConstraintResult[];
}

interface GapCandidateShape<D extends EngineDimension> {
  readonly id: string;
  readonly operation: GapOperation;
  readonly geometry: readonly EngineVector<D>[];
  readonly features: GapCandidateFeatures;
  readonly assessment: GapCandidateAssessment;
}

export type GapCandidate<
  D extends EngineDimension = EngineDimension,
> = D extends EngineDimension ? GapCandidateShape<D> : never;

interface GapAnalysisShape<D extends EngineDimension> {
  readonly schema: "gtr.analysis/v1";
  readonly algorithm: {
    readonly id: "gtr-geometry-proposal";
    readonly version: "1";
    readonly numericProfile:
      "binary64-geometry-significant-15-alignments";
  };
  readonly network: {
    readonly networkId: string;
    readonly revision: string;
    readonly digest: string;
    readonly dimensions: D;
    readonly unit: string;
    readonly frame: string;
  };
  readonly configurationDigest: string;
  readonly executionProfileDigest: string;
  readonly executionComplete: true;
  readonly candidates: readonly GapCandidate<D>[];
  readonly selection: {
    readonly policy: "per-endpoint-union";
    readonly truncated: boolean;
    readonly omitted: number;
    readonly maxCandidatesPerEndpoint: number;
  };
  readonly summary: {
    readonly nodes: number;
    readonly edges: number;
    readonly endpoints: number;
    readonly neighborChecks: number;
    readonly candidatesConsidered: number;
    readonly candidatesReturned: number;
    readonly statusCounts: {
      readonly review: number;
      readonly reject: number;
      readonly abstain: number;
    };
  };
  readonly warnings: readonly string[];
  readonly digest: string;
}

export type GapAnalysis<
  D extends EngineDimension = EngineDimension,
> = D extends EngineDimension ? GapAnalysisShape<D> : never;

export class GapAnalysisEngine<
  D extends EngineDimension = EngineDimension,
> {
  constructor(input: GapEngineInput<D>);
  analyze(): GapAnalysis<D>;
}

export function createGapEngine<
  D extends EngineDimension = EngineDimension,
>(input: GapEngineInput<D>): GapAnalysisEngine<D>;

export function analyzeGaps<
  D extends EngineDimension = EngineDimension,
>(input: GapEngineInput<D>): GapAnalysis<D>;
