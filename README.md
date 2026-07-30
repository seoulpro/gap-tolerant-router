# gap-tolerant-router

A deterministic, zero-dependency router for imperfect planar line networks.

Real line data is often almost routable rather than perfectly routable:
duplicate endpoint records split intersections, digitising gaps separate nearby
components, T-junctions stop just short of a line, and query points rarely land
exactly on a node. This package repairs those defects in memory and runs an A*
search, without assuming a particular database, coordinate reference system, map
renderer, or application domain.

The repairs are heuristics. The package does not infer legal access, transport
policy, or real-world safety.

- Merges endpoint records within a configurable coordinate tolerance, but never
  collapses two nodes that a real segment directly joins.
- Adds penalized connectors only between nearby disconnected components.
- Projects a dead end onto a nearby foreign segment to recover an unsnapped
  T-junction.
- Projects arbitrary start and goal coordinates onto one or more candidate
  lines.
- Preserves one-way traversal rules, including one-way self-loops.
- Keeps long, last-resort bridges disabled unless the caller explicitly opts
  in.
- Returns diagnostics and structured, localizable route instructions.

The package also ships an optional, proposal-only gap analysis engine for review
and QA workflows.

## Two entry points

There are two independent entry points:

- `gap-tolerant-router` — the deterministic 2D `GapRouter` route finder
  documented below. Use it to repair an imperfect planar network in memory and
  find a least-cost route between two points.
- `gap-tolerant-router/engine` — a proposal-only gap analysis engine. Use it to
  enumerate and assess candidate connections in a 2D or 3D network snapshot
  without mutating the graph and without choosing a route.

Reach for the router when you need a path. Reach for the engine when you need a
reviewable list of where a network might be joined, with each candidate marked
`review`, `reject`, or `abstain` for an external decision. The engine never
authorizes a change; see [Gap proposal engine](#gap-proposal-engine).

## Install

```sh
npm install gap-tolerant-router
```

The package is published on npm as
[gap-tolerant-router](https://www.npmjs.com/package/gap-tolerant-router).

Node.js 22 or newer is required. The package is ESM-only and has no runtime
dependencies. TypeScript declarations are included.

## Example

```js
import { GapRouter, buildInstructions } from "gap-tolerant-router";

const router = new GapRouter({
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 20, y: 0 },
    { id: "c", x: 24, y: 0 },
    { id: "d", x: 44, y: 0 }
  ],
  segments: [
    {
      id: "west",
      from: "a",
      to: "b",
      coordinates: [[0, 0], [20, 0]],
      speed: 8
    },
    {
      id: "east",
      from: "c",
      to: "d",
      coordinates: [[24, 0], [44, 0]],
      speed: 8
    }
  ],
  options: {
    mergeTolerance: 0.5,
    maxGapDistance: 6
  }
});

const route = router.route(
  { x: 2, y: 1 },
  { x: 42, y: -1 },
  { maxSnapDistance: 5 }
);

if (route.ok) {
  console.log(route.coordinates);
  console.log(buildInstructions(route.legs));
}
```

Coordinates and speeds are unit-agnostic as long as the caller uses one
consistent system. Route `cost` is measured in the time unit implied by
`length / speed`. A custom segment `length` is distributed proportionally across
projected subsegments.

## Input contract

Nodes may be an array of `{ id, x, y }` or a `Map<id, { x, y }>`. Node and
segment IDs must be strings or finite numbers, and unique within their
respective collections. Coordinates, lengths, speeds, and distance options are
validated before spatial indexes are built; malformed or non-finite graph data
throws a `TypeError`, and a duplicate node or segment ID is rejected.

Each segment's geometry must start and end within `endpointTolerance` of its
`from` and `to` node coordinates, and must have positive measured length. When
endpoint records merge, a segment's geometry endpoints are moved to the
canonical node position so route geometry stays continuous; the segment's
logical `length` keeps the supplied or original measured value and is
apportioned over the normalized geometry.

Segments use:

```ts
{
  id: string | number;
  from: string | number;
  to: string | number;
  coordinates: Array<[number, number]>;
  length?: number;   // logical length; defaults to measured geometry length
  speed?: number;    // defaults to the gapSpeed option
  oneWay?: boolean;  // defaults to false
  metadata?: unknown;
}
```

Constructor options and their defaults:

| Option | Default | Effect |
| --- | ---: | --- |
| `mergeTolerance` | `1` | Maximum endpoint distance for merging node records |
| `endpointTolerance` | `mergeTolerance` | Maximum distance a segment's geometry endpoints may sit from their node coordinates |
| `maxGapDistance` | `40` | Maximum ordinary repair-connector distance |
| `gapConnectorsPerNode` | `2` | Maximum nearby-component connectors considered per node |
| `gapFixedCost` | `4` | Fixed nonzero penalty added to each connector |
| `gapCostFactor` | `1.35` | Multiplier applied to connector travel cost |
| `gapSpeed` | `1.4` | Speed used for connectors, and the default segment speed |
| `projectionMinGain` | `2` | Required improvement before projecting a dead end onto a line |
| `segmentSampleStep` | `64` | Spacing used by the segment spatial index |
| `respectOneWay` | `true` | Whether `oneWay` segments forbid reverse traversal |
| `maxFallbackBridges` | `0` | Long fallback bridges allowed during one route search |
| `maxFallbackBridgeDistance` | `Infinity` | Distance bound for an enabled fallback bridge |

A smaller `segmentSampleStep` trades memory and construction time for a denser
spatial index. `endpointTolerance` follows `mergeTolerance` unless set
explicitly. `maxFallbackBridgeDistance` has no effect while `maxFallbackBridges`
is zero.

When fallback bridges are enabled, each one first tries to connect the
start-reachable region directly toward the goal-reachable region; if no such
pair is within `maxFallbackBridgeDistance`, it instead expands to the nearest
unreached component, repeating up to `maxFallbackBridges` times. A fallback
bridge only joins two different weakly connected components; it never bridges
within a single component to bypass a one-way restriction. This is a last-resort
heuristic: it joins geometry by proximity and does not establish that a
connection is semantically valid.

Per-call `route` options:

| Option | Default | Effect |
| --- | ---: | --- |
| `maxSnapDistance` | `maxGapDistance * 2` | Maximum distance from a query point to the nearest line |
| `anchorCandidateCount` | `3` | Maximum candidate lines a query point may attach to |
| `maxFallbackBridges` | constructor value | Overrides the constructor option for this search |
| `maxFallbackBridgeDistance` | constructor value | Overrides the constructor option for this search |

## Result shape

`route(start, goal, options)` returns either a successful route or a documented
failure:

```ts
type RouteResult =
  | {
      ok: true;
      coordinates: Array<[number, number]>;
      legs: Array<{
        kind: "network" | "gap";
        length: number;
        cost: number;
        coordinates: Array<[number, number]>;
        segmentId?: string | number;
        reason?: string;
        metadata?: unknown;
      }>;
      distance: number;
      cost: number;
      snapDistance: { start: number; goal: number };
      diagnostics: {
        mergedNodes: number;
        gapConnectors: number;
        projectedDeadEnds: number;
        fallbackBridges: number;
      };
    }
  | {
      ok: false;
      reason:
        | "start-not-near-network"
        | "goal-not-near-network"
        | "no-route";
    };
```

`coordinates` is the continuous route polyline, starting at `start` and ending
at `goal`. Each `gap` leg carries a `reason` drawn from `anchor-snap`,
`nearby-components`, `dead-end-projection`, or `fallback-bridge`. When `start`
and `goal` are identical and the point is near the network, the result is a
successful zero-length route with no legs.

Failure reasons:

- `start-not-near-network` — no segment lies within `maxSnapDistance` of the
  start point.
- `goal-not-near-network` — no segment lies within `maxSnapDistance` of the goal
  point.
- `no-route` — both endpoints attach, but no path connects them within the
  allowed connectors and fallback bridges.

The `lineLength` and `projectPointToLine` exports are available for building
adapters. `createRouter(input)` is equivalent to `new GapRouter(input)`.

## Instructions

`buildInstructions(legs, options)` derives `depart`, `turn`, `leave-network`,
`resume-network`, and `arrive` events from a route's legs. It returns structured
events rather than localized text; each event carries a `kind`, an optional
`modifier`, a passed-through `reason` and `metadata`, an `at` point, and the
`distance` and `cost` of travel from that event until the next event.

Its defaults are 25° for a turn, 45° as the largest slight turn, 120° as the
smallest sharp turn, 160° as the smallest U-turn, 12 distance units before a gap
is announced, and 8 units of minimum spacing between turn events. Bearings assume
Cartesian coordinates with the positive `y`-axis pointing upward; invert `y`
before routing screen-coordinate data if left/right instructions must follow that
convention. Unknown or inconsistent instruction options and malformed leg
geometry are rejected with a `TypeError`.

## Determinism and mutation

- Given equivalent input, results are identical regardless of node or segment
  order; ties are broken by ID.
- Repeated identical queries on the same router return equal results.
- The constructor copies the nodes, segments, and options it is given, so
  mutating those inputs afterwards does not change the built router.
- Returned route geometry and numeric routing fields are copied before return,
  so changing them cannot affect a later routing computation.
- `metadata` is passed through by reference as opaque, caller-owned data; it is
  not cloned, so changes to it are visible wherever the caller shares that
  object.
- Per-query anchors and any fallback bridges are discarded after each `route`
  call and never accumulate across queries.

## Router reference scenarios

A fully synthetic, deterministic fixture exercises the repairs and guards on a
small planar network. It is generated from a fixed seed and is not production
data, derived data, or anonymized real data. The eight cases are:

| Case | Scenario | Expected result | Repair or guard |
| --- | --- | --- | --- |
| case-001 | Ordinary route | route, 71 units | two anchor snaps; only `anchor-snap` |
| case-002 | Endpoint merge | route, 81.355395 units | endpoint records merged; no gap leg |
| case-003 | Short component gap | route, 82 units | `nearby-components` |
| case-004 | Undershot junction | route, 57 units | `dead-end-projection` |
| case-005 | Off-network points | route, 55.218253 units | start and goal `anchor-snap` |
| case-006 | One-way rejection | `no-route` | reverse traversal stays forbidden |
| case-007 | Disconnected components | `no-route` | no fallback enabled |
| case-008 | Opt-in fallback | route, 98 units | one `fallback-bridge` |

The fixture pairs a clean network (73 nodes, 75 segments) with an imperfect
network (74 nodes, 72 segments) that introduces the defects each case covers.

A local reference benchmark run and its methodology are recorded in
[docs/benchmarks.md](./docs/benchmarks.md). Those timings describe one machine
and are not a performance guarantee.

## Limits

This repository intentionally contains no:

- storage or SQL adapter;
- geographic projection assumption;
- UI or localization strings;
- remote service integration;
- real, derived, identifiable, operational, personal, or clinical data.

Adapters can translate GeoJSON, database rows, CAD linework, indoor networks, or
other sources into the small input contract. The repository does include
synthetic, domain-shaped fixtures for the
[gap proposal engine](#gap-proposal-engine); those are contract examples only
and carry none of the data listed above.

The repair steps are heuristics, not a proof that every disconnected component
should be joined. Evaluate tolerances and costs against the scale and semantics
of your data. Construction raises a `RangeError` when a segment would require more
than 1,000,000 spatial-index samples across all of its coordinate pairs; raise
`segmentSampleStep` to index such a segment. Without an explicit limits profile,
router validation does not impose a graph-size limit; callers accepting
untrusted data should bound node and segment counts. Most router
compatibility limits default to `Infinity`, while the spatial-sample guards
above remain in place. To harden a service or an untrusted upload, pass an
optional `limits` profile on the router input (for example `maxNodes`,
`maxSegments`, `maxCoordinates`, `maxSpatialSamplesTotal`,
`maxCandidateEvaluations`, `maxSearchExpansions`, or
`maxFallbackPairEvaluations`) and handle the `RouterLimitError` it throws when a
bound is exceeded. The API may change during the `0.x` series as adapter and
large-network use cases are exercised.

## Gap proposal engine

The `gap-tolerant-router/engine` entry point is a separate, proposal-only tool.
Given a snapshot of a network, it enumerates candidate connections
across gaps and assesses each one for later review. It never routes, never
mutates the graph, and never authorizes a repair: every candidate is geometry
proposed for an external human or domain-specific decision.

```js
import { analyzeGaps } from "gap-tolerant-router/engine";

const analysis = analyzeGaps({
  snapshot: {
    schema: "gtr.network/v1",
    networkId: "example-site",
    revision: "1",
    space: { dimensions: 2, unit: "m", frame: "site-grid" },
    nodes: [
      { id: "a-source", position: [-2, 0] },
      { id: "a-tip", position: [0, 0] },
      { id: "b-tip", position: [0.8, 0] },
      { id: "b-source", position: [2.8, 0] }
    ],
    edges: [
      { id: "a", from: "a-source", to: "a-tip", geometry: [[-2, 0], [0, 0]] },
      { id: "b", from: "b-tip", to: "b-source", geometry: [[0.8, 0], [2.8, 0]] }
    ]
  },
  proposal: { maxGapDistance: 1 },
  limits: { maxNodes: 1000, maxEdges: 1000 }
});

for (const candidate of analysis.candidates) {
  console.log(
    candidate.operation.kind,
    candidate.assessment.status,
    candidate.features.distance
  );
}
```

`maxGapDistance` defaults to `0`, so only zero-distance candidates are eligible
until the caller sets a larger review radius.

### Input boundary

Input is a `gtr.network/v1` snapshot in 2D or 3D Euclidean space. Nodes carry an
`id` and a dimension-matched finite coordinate tuple; edges carry an `id`,
`from`/`to` node ids, an endpoint-matching polyline `geometry`, an optional
`direction` (`"both" | "forward" | "reverse"`), and optional scalar-only
`properties` (string, number, boolean, or null). The snapshot is copied on entry
and is never modified.

Input must be plain in-memory data — dense arrays and ordinary records. Proxies,
accessors, symbols, non-enumerable fields, unknown schema fields, non-scalar
properties, non-finite numbers, and edges whose geometry does not meet their
endpoints are rejected; a validation error may name the offending field.

### Candidates and statuses

Each candidate describes one `operation`:

- `connect-nodes` — join an endpoint or isolated node to another node. Its
  `direction` is deliberately `"unspecified"`.
- `attach-node-to-edge` — attach an endpoint or isolated node to a projected
  point on the interior of an edge.

Every candidate is assessed as one of:

- `review` — the configured geometric constraints passed; an external decision
  is still required.
- `reject` — a hard constraint failed, for example a forbidden pair or a
  same-component connection when different components are required.
- `abstain` — evidence is insufficient for `review`, for example missing
  tangent evidence when it is required.

There is no confidence or probability field, and no status means approval or
automatic repair. A `review` result always defers to an external decision.

### Constraints

Assessment applies the hard constraints an adapter supplies:

- forbidden node-to-node pairs;
- forbidden node-to-edge pairs;
- an optional different-component requirement;
- an optional tangent-evidence requirement.

The engine does not infer voltage, pressure, materials compatibility, clearance,
cell identity, compartment class, synapses, or any other domain meaning. An
adapter must supply those constraints and its own approval workflow.

### Determinism and digests

Given equal input, the analysis is reproducible: candidate identity is a content
digest and candidates are ordered deterministically, independent of input
ordering. Geometry features use raw binary64 distances; tangent alignments are
normalized to 15 significant digits. The published numeric profile is
`binary64-geometry-significant-15-alignments`.

The analysis carries SHA-256 digests for the network, the configuration, the
execution profile, candidate identities, and the whole analysis, so a run can
be identified and reproduced. The configuration digest is scoped to the
normalized network digest. These digests are reproducibility and integrity
identifiers only — they are not signatures, authentication, confidentiality,
or anonymization. Identifiers and property values feed the fingerprints
unchanged, so remove or tokenize sensitive values before analysis.

### Selection and bounded execution

Candidate selection uses a `per-endpoint-union` policy: the returned set is the
union of each endpoint's top `maxCandidatesPerEndpoint` candidates, not a strict
degree cap on any one node or edge. The spatial search is a deterministic
balanced AABB tree over nodes and individual polyline segments.

Execution is bounded by default. The default limits are:

| Limit | Default |
| --- | ---: |
| `maxNodes` | 25,000 |
| `maxEdges` | 25,000 |
| `maxTotalPoints` | 100,000 |
| `maxPropertyFields` | 25,000 |
| `maxPropertyBytes` | 1,000,000 |
| `maxStringBytes` | 1,000,000 |
| `maxConstraintPairs` | 25,000 |
| `maxNeighborChecks` | 500,000 |
| `maxCandidatesTotal` | 10,000 |
| `maxOutputBytes` | 16,000,000 |

`limits` is an operator-controlled execution profile; do not copy limit values
from an untrusted request. Bounds are enforced during input, candidate
generation, and output, and a `GapEngineLimitError` (a `RangeError` carrying
`code`, `phase`, `limit`, and `actual`) is thrown when one is exceeded. Request-
and body-size limits and parser isolation remain the adapter's responsibility.

### Synthetic industrial conformance fixtures

Four fully synthetic fixtures under `examples/industrial-conformance/` show the
engine's contract across different network shapes. Run them with:

```sh
npm run examples:industrial
```

| Fixture | Candidate | Status | Distance | Scope boundary |
| --- | --- | --- | ---: | --- |
| Utility distribution gap | connect nodes | `review` | 0.8 m | This geometry review is not electrical phase, protection, switching, energization, or work-permit approval. |
| Process tie-in | attach node to edge | `reject` | 0.6 m | The supplied constraint blocks this geometric candidate; it is not a HAZOP, materials, pressure, flow-direction, or tie-in permit decision. |
| AMR missing heading | connect nodes | `abstain` | 0.5 m | No aisle direction, footprint, clearance, obstacle, kinematic, traffic-control, mission, or safety-controller authorization is inferred. |
| 3D biomedical morphology gap | connect nodes | `review` | 0.7071067811865476 um | Proximity and tangent alignment do not establish cell identity, neurite continuity, compartment class, synapse, biological causality, diagnosis, or permission to repair a skeleton. |

These fixtures are synthetic contract examples. They contain no real, derived,
identifiable, operational, personal, or clinical data, and they are not
performance, safety, or domain-validity evidence.

## Development

Install development dependencies and run the full quality gate:

```sh
npm ci
npm run check
```

`npm run check` runs the source syntax checks, the TypeScript consumer checks,
the test suite under coverage thresholds, and a packed-tarball installation
smoke test.

`npm run examples:industrial` runs the four synthetic industrial conformance
fixtures, checking that each one still produces its expected candidate,
operation, distance, and status, and prints the scope-boundary table.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for test and design expectations and
[SECURITY.md](./SECURITY.md) for private reporting.

## License

[MIT](./LICENSE)
