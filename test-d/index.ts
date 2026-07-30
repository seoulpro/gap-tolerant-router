import {
  GapRouter,
  RouterLimitError,
  buildInstructions,
  createRouter,
  lineLength,
  projectPointToLine,
  type RouteResult,
  type RouterInput,
  type RouterLimits,
} from "gap-tolerant-router";

interface Metadata {
  name: string;
}

const input: RouterInput<Metadata> = {
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 10, y: 0 },
  ],
  segments: [{
    id: "line",
    from: "a",
    to: "b",
    coordinates: [[0, 0], [10, 0]],
    metadata: { name: "main" },
  }],
  options: {
    endpointTolerance: 0,
    mergeTolerance: 0,
  },
  limits: {
    maxNodes: 100,
    maxSearchExpansions: 10_000,
  },
};

const limits: RouterLimits = {
  maxCandidateEvaluations: 50_000,
  maxSpatialSamplesTotal: 50_000,
};
void limits;

const router = new GapRouter(input);
const equivalent = createRouter(input);
const result: RouteResult<Metadata> = router.route(
  { x: 1, y: 0 },
  { x: 9, y: 0 },
  { maxSnapDistance: 1 },
);
equivalent.route({ x: 1, y: 0 }, { x: 9, y: 0 });

if (result.ok) {
  result.coordinates[0][0] = result.coordinates[0][0];
  const name: string | undefined = result.legs[0]?.metadata?.name;
  void name;
  buildInstructions(result.legs, {
    minimumEventSpacing: 5,
    turnThresholdDegrees: 20,
  });
} else {
  const reason:
    | "start-not-near-network"
    | "goal-not-near-network"
    | "no-route" = result.reason;
  void reason;
}

const length: number = lineLength([[0, 0], [3, 4]]);
const projection = projectPointToLine(
  { x: 2, y: 1 },
  [[0, 0], [4, 0]],
);
const projectedX: number | undefined = projection?.x;
void length;
void projectedX;

try {
  throw new RouterLimitError(
    "MAX_NODES",
    "input",
    1,
    2,
  );
} catch (error) {
  if (error instanceof RouterLimitError) {
    const code: "MAX_NODES"
      | "MAX_SEGMENTS"
      | "MAX_COORDINATES"
      | "MAX_SPATIAL_SAMPLES_TOTAL"
      | "MAX_CANDIDATE_EVALUATIONS"
      | "MAX_SEARCH_EXPANSIONS"
      | "MAX_FALLBACK_PAIR_EVALUATIONS" = error.code;
    void code;
  }
}

// @ts-expect-error coordinates must contain numbers
lineLength([[0, "invalid"]]);

// @ts-expect-error route points require both x and y
router.route({ x: 0 }, { x: 1, y: 0 });
