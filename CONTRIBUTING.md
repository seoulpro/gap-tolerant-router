# Contributing to gap-tolerant-router

Issues and focused pull requests are welcome. Please open an issue first for a
new repair heuristic, a change to route cost or a default tolerance, or any
breaking change to the input or output contract, so the design can be discussed
before code is written. Small, self-evident correctness fixes can go straight to
a pull request.

## Development

The package requires Node.js 22 or newer. Install the development dependencies,
then run the full quality gate:

```sh
npm ci
npm run check
```

`npm run check` runs the source syntax checks, the TypeScript consumer checks
(`test-d/`), the `node:test` suite under its coverage thresholds, and a
packed-tarball installation smoke test. Please make it pass before opening a
pull request.

## Where tests belong

- `test/router.test.js` — end-to-end routing behavior and the exported geometry
  helpers.
- `test/validation.test.js` — input validation and the errors thrown for
  malformed graphs and options.
- `test/invariants.test.js` — properties that must hold across many inputs, such
  as order-independence and cost/geometry accounting.
- `test/regressions.test.js` — a minimal network that reproduces a specific
  fixed bug, asserting both the route and the relevant diagnostics.
- `test/instructions.test.js` — `buildInstructions` output and option handling.
- `test/performance.test.js` — the bounded build-and-search smoke budget.
- `test/engine.test.js` — `gap-tolerant-router/engine` analysis behavior:
  candidates, statuses, operations, constraints, digests, and determinism.
- `test/engine-conformance.test.js` — the synthetic industrial fixtures under
  `examples/industrial-conformance/` and their expected candidate, operation,
  distance, and status.
- `test/engine-performance.test.js` — the engine's bounded execution smoke
  budget.
- `test/limits.test.js` — router resource limits and the errors they raise;
  engine limits are covered in `test/engine.test.js`.
- `test/numerics.test.js` — the exact, order-independent numeric helpers.

Represent topology bugs with minimal in-memory networks and unitless
coordinates. Do not add real routes or identifiable map data; engine fixtures
must stay fully synthetic and free of real, derived, operational, personal, or
clinical data.

## Invariants to preserve

Changes should keep, and where relevant add coverage for:

- equivalent input produces identical output, with ties broken by ID;
- nodes joined by a real segment are never collapsed by endpoint merging;
- one-way traversal (and one-way self-loops) are respected;
- query anchors and fallback bridges do not persist between `route` calls;
- returned geometry and numeric leg fields are copied, so results cannot alter
  later searches;
- nearby-component connectors and fallback bridges stay bounded;
- distance and cost accounting stays stable and symmetric on two-way networks.

## Design constraints

The core stays independent of storage, GeoJSON, coordinate reference systems,
transport policy, and user-facing text. Long fallback bridges must remain
opt-in. If a change alters a default tolerance or cost, explain the
compatibility and performance impact in the pull request.

See [SECURITY.md](./SECURITY.md) for private reporting. Contributions are made
under the [MIT license](./LICENSE).
