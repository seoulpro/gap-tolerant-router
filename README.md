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

## Install

The package is not published to a registry. Install it from a source checkout.
Clone the repository, then from the checkout run:

```sh
npm ci
```

To consume it from another local project, reference the checkout directory, for
example a sibling directory:

```sh
npm install ../gap-tolerant-router
```

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

## Limits

This repository intentionally contains no:

- storage or SQL adapter;
- geographic projection assumption;
- UI or localization strings;
- remote service integration;
- domain-specific fixtures.

Adapters can translate GeoJSON, database rows, CAD linework, indoor networks, or
other sources into the small input contract.

The repair steps are heuristics, not a proof that every disconnected component
should be joined. Evaluate tolerances and costs against the scale and semantics
of your data. Construction raises a `RangeError` when a segment would require more
than 1,000,000 spatial-index samples across all of its coordinate pairs; raise
`segmentSampleStep` to index such a segment. Validation does not impose a graph-size limit; callers
accepting untrusted data should bound node and segment counts. The API may change
during the `0.x` series as adapter and large-network use cases are exercised.

## Development

Install development dependencies and run the full quality gate:

```sh
npm ci
npm run check
```

`npm run check` runs the source syntax checks, the TypeScript consumer checks,
the test suite under coverage thresholds, and a packed-tarball installation
smoke test.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for test and design expectations and
[SECURITY.md](./SECURITY.md) for private reporting.

## License

[MIT](./LICENSE)
