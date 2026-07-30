# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `gap-tolerant-router/engine` subpath export: a proposal-only gap analysis
  engine (`analyzeGaps`, `createGapEngine`, `GapAnalysisEngine`) that copies a
  `gtr.network/v1` snapshot in 2D or 3D Euclidean space and returns candidate
  connections without routing or mutating the source graph. Each candidate
  carries geometry, binary64 distance and tangent-alignment features
  (alignments normalized to 15 significant digits), an operation
  (`connect-nodes` with `direction: "unspecified"`, or `attach-node-to-edge`),
  and an assessment of `review`, `reject`, or `abstain`; there is no confidence
  field and `review` always defers to an external decision.
- Deterministic engine behavior: content-addressed candidate identity, ordering
  independent of input order, forbidden node-pair and node-to-edge constraints,
  optional different-component and tangent-evidence requirements, and
  `per-endpoint-union` candidate selection over a balanced AABB spatial index.
- SHA-256 network, configuration, execution-profile, candidate-identity, and
  analysis digests for reproducibility and integrity checking. The digests are
  not signatures, authentication, or anonymization.
- Bounded engine execution: default resource limits (`maxNodes`, `maxEdges`,
  `maxTotalPoints`, `maxPropertyFields`, `maxPropertyBytes`, `maxStringBytes`,
  `maxConstraintPairs`, `maxNeighborChecks`, `maxCandidatesTotal`, and
  `maxOutputBytes`) enforced across input, candidate generation, and output,
  reported through `GapEngineLimitError`.
- Optional `limits` execution profile and `RouterLimitError` for the existing
  `GapRouter`. Most limits default to `Infinity` for backward compatibility,
  while the existing spatial-sample guards remain in place.
- Four fully synthetic industrial conformance fixtures under
  `examples/industrial-conformance/`, runnable with
  `npm run examples:industrial`. They are contract examples only and contain no
  real, derived, identifiable, operational, personal, or clinical data.
- TypeScript declarations and packed-package smoke coverage for the engine
  subpath.

### Changed

- Hardened numeric projection and geometry handling across extreme finite
  coordinate scales and reversed segment orientation, and tightened validation
  to reject non-finite route distances and degenerate spatial grids.

## 0.1.1 - 2026-07-28

### Fixed

- Corrected the README installation guidance to the published npm package
  (`npm install gap-tolerant-router`) instead of a local source checkout.

## 0.1.0 - 2026-07-28

Initial release.

### Added

- `GapRouter` and the `createRouter` factory: build a router from nodes and
  segments, then find a least-cost route between two arbitrary coordinates.
- Connectivity repair for imperfect planar line networks: merging of nearly
  coincident endpoint records (without collapsing nodes joined by a real
  segment), penalized connectors between nearby disconnected components,
  projection of dead ends onto nearby foreign segments, and snapping of query
  points onto candidate lines.
- One-way traversal support, including one-way self-loops, with a
  `respectOneWay` option to disable it.
- Opt-in, distance-bounded fallback bridges that can span multiple intermediate
  components, disabled by default.
- Structured route results: continuous route geometry, per-leg `network` and
  `gap` breakdown with `reason` and pass-through `metadata`, aggregate distance
  and cost, snap distances, and repair diagnostics. Given equivalent input,
  results are deterministic with ID-based tie breaking, and returned geometry
  and numeric fields are copied so results cannot affect later searches.
- `buildInstructions`, which turns route legs into structured `depart`, `turn`,
  `leave-network`, `resume-network`, and `arrive` events with configurable turn
  thresholds, rather than localized text.
- `lineLength` and `projectPointToLine` geometry helpers for building adapters.
- TypeScript declarations for the full public API.
- Input validation that rejects malformed or non-finite graph data, duplicate
  IDs, out-of-tolerance segment endpoints, and unknown or inconsistent options
  before any spatial index is built, plus a `RangeError` guard against segments
  that would require an unsafe number of index samples.
- Test suite covering routing behavior, validation, cross-input invariants,
  regressions, instructions, and a bounded performance smoke test.
- ESM-only packaging with no runtime dependencies, requiring Node.js 22 or
  newer, with a package archive that contains the source, type declarations,
  and documentation.
