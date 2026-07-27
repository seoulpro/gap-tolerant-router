# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
