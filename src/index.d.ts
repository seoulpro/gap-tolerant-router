export type NodeId = string | number;
export type Coordinate = [number, number];
export type CoordinateInput = readonly [number, number];

export interface Point {
  x: number;
  y: number;
}

export interface RouterNode extends Point {
  id: NodeId;
}

export interface Segment<Metadata = unknown> {
  id: NodeId;
  from: NodeId;
  to: NodeId;
  coordinates: readonly CoordinateInput[];
  length?: number;
  speed?: number;
  oneWay?: boolean;
  metadata?: Metadata;
}

export interface RouterOptions {
  mergeTolerance?: number;
  endpointTolerance?: number;
  maxGapDistance?: number;
  gapConnectorsPerNode?: number;
  gapFixedCost?: number;
  gapCostFactor?: number;
  gapSpeed?: number;
  projectionMinGain?: number;
  segmentSampleStep?: number;
  respectOneWay?: boolean;
  maxFallbackBridges?: number;
  maxFallbackBridgeDistance?: number;
}

export interface RouterInput<Metadata = unknown> {
  nodes: readonly RouterNode[] | Map<NodeId, Point>;
  segments: readonly Segment<Metadata>[];
  options?: RouterOptions;
}

export interface RouteOptions {
  anchorCandidateCount?: number;
  maxFallbackBridgeDistance?: number;
  maxFallbackBridges?: number;
  maxSnapDistance?: number;
}

export type GapReason =
  | "anchor-snap"
  | "dead-end-projection"
  | "fallback-bridge"
  | "nearby-components";

export interface RouteLeg<Metadata = unknown> {
  kind: "network" | "gap";
  length: number;
  cost: number;
  coordinates: Coordinate[];
  segmentId?: NodeId;
  reason?: string;
  metadata?: Metadata | null;
}

export interface RouteDiagnostics {
  mergedNodes: number;
  gapConnectors: number;
  projectedDeadEnds: number;
  fallbackBridges: number;
}

export interface RouteSuccess<Metadata = unknown> {
  ok: true;
  coordinates: Coordinate[];
  legs: RouteLeg<Metadata>[];
  distance: number;
  cost: number;
  snapDistance: {
    start: number;
    goal: number;
  };
  diagnostics: RouteDiagnostics;
}

export interface RouteFailure {
  ok: false;
  reason:
    | "start-not-near-network"
    | "goal-not-near-network"
    | "no-route";
}

export type RouteResult<Metadata = unknown> =
  | RouteSuccess<Metadata>
  | RouteFailure;

export interface Projection {
  index: number;
  t: number;
  x: number;
  y: number;
  distance: number;
  distanceAlong: number;
}

export interface InstructionOptions {
  turnThresholdDegrees?: number;
  slightTurnMaxDegrees?: number;
  sharpTurnMinDegrees?: number;
  uTurnMinDegrees?: number;
  minimumGapInstructionDistance?: number;
  minimumEventSpacing?: number;
}

export type InstructionKind =
  | "depart"
  | "turn"
  | "leave-network"
  | "resume-network"
  | "arrive";

export type InstructionModifier =
  | "slight-left"
  | "slight-right"
  | "left"
  | "right"
  | "sharp-left"
  | "sharp-right"
  | "u-turn";

export interface RouteInstruction<Metadata = unknown> {
  kind: InstructionKind;
  modifier: InstructionModifier | null;
  reason: string | null;
  metadata: Metadata | null;
  distance: number;
  cost: number;
  at: Point;
}

export class GapRouter<Metadata = unknown> {
  constructor(input: RouterInput<Metadata>);
  route(
    start: Point,
    goal: Point,
    options?: RouteOptions,
  ): RouteResult<Metadata>;
}

export function createRouter<Metadata = unknown>(
  input: RouterInput<Metadata>,
): GapRouter<Metadata>;

export function lineLength(coordinates: readonly CoordinateInput[]): number;

export function projectPointToLine(
  point: Point,
  coordinates: readonly CoordinateInput[],
): Projection | null;

export function buildInstructions<Metadata = unknown>(
  legs: readonly RouteLeg<Metadata>[],
  options?: InstructionOptions,
): RouteInstruction<Metadata>[];
