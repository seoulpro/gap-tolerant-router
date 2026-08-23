# Benchmark guide

The suite under `benchmark/` measures both entry points of this package: the
deterministic `GapRouter` (construction and route queries) and the proposal-only
gap analysis engine. It runs from a clean checkout with no extra dependencies,
and it is meant for comparing one revision of this repository against another on
the same machine.

Timings are not a performance guarantee. They describe one machine, one Node.js
build, and the synthetic fixtures below.

## Running the suite

```sh
npm run benchmark          # quick profile: router construction, the eight route cases, five engine workloads
npm run benchmark:scaling  # the same shapes at several sizes, to observe how cost grows
npm run benchmark:stress   # heavier dense-engine, projection, and large-grid workloads
npm run benchmark -- --help
```

The help output lists the flags each profile accepts: `--profile`, `--case`
(repeatable), `--sizes`, `--runs`, `--warmup`, `--sample-time`, and `--json`.
Selecting cases or sizes filters the chosen profile rather than adding new work.

Without `--json` the runner prints a table of median, p95, coefficient of
variation, operations per second, and a short output digest per case.

## Capturing machine-readable reports

Use `--json` to write a report you can keep and compare later. Raising the
sample count and the target sample duration above the profile defaults gives a
steadier baseline:

```sh
npm run benchmark -- --runs=30 --warmup=3 --sample-time=100 --json > benchmark-before.json
# apply a change, then
npm run benchmark -- --runs=30 --warmup=3 --sample-time=100 --json > benchmark-after.json
```

A report carries `schemaVersion`, the suite name, the package version, the
profile, the resolved configuration, environment metadata, the source revision
and whether the worktree was dirty, and one entry per case with its parameters,
per-sample timings, statistics, and output digest.

## Comparing two reports

```sh
npm run benchmark:compare -- benchmark-before.json benchmark-after.json
npm run benchmark:compare -- --fail-on-output-change benchmark-before.json benchmark-after.json
```

The comparison joins cases by name and size, refuses to compare reports whose
case parameters differ, and warns when the environment, the configuration, or
the profile is not the same. For each case it reports both medians, the
percentage change, both coefficients of variation, and whether the output digest
stayed the same. A positive change is slower. The deltas are descriptive; they
are not a statistical significance claim. Add `--json` for machine-readable
comparison output.

By default the command is descriptive and exits successfully even when an
output digest changed. Pass `--fail-on-output-change` in CI to receive exit code
`1` after the comparison is printed whenever equivalent cases produced
different output. Timing changes remain descriptive because noisy benchmark
samples are not a reliable universal pass/fail threshold.

## Method

- **Fixed synthetic fixtures.** Every case is built in-process from the
  generators in `benchmark/fixtures.mjs`. The router fixture comes from the
  fixed seed `synthetic-planar-set-v1`; the grid and engine fixtures are
  deterministic functions of their size. Nothing is downloaded, sampled, or
  read from disk, and none of it is production data, derived data, or anonymized
  real data.
- **One process per configuration.** The runner spawns a fresh Node.js worker
  for each case and size, so JIT state, heap growth, and inline caches do not
  carry across configurations.
- **Calibration.** Each worker first measures a single operation, then doubles
  the batch size until it reaches a fifth of the target sample duration, and
  derives the number of operations per sample from that. Reported timings are
  per operation.
- **Statistics.** Each sample is one batch. The runner reports minimum, median,
  p95, maximum, mean, standard deviation, the coefficient of variation as a
  percentage, and operations per second computed from the median.
- **Output digest verification.** Every case defines what its operation
  produces — a route summary, an analysis digest and selection summary, or the
  fields of an expected limit error. The runner hashes that value once as a
  baseline and re-checks it after every warmup, calibration batch, and measured
  sample, so a run that silently changed its result fails instead of reporting a
  faster number. The eight router reference cases additionally assert their
  expected distance or `no-route` reason and their expected repair reasons.
- **Environment metadata.** Reports record the Node.js and V8 versions, the
  platform and architecture, the first CPU model, the logical CPU count, the
  package version, the git revision, and whether the worktree was dirty.
  Hostnames, usernames, environment variables, and local paths are not
  collected; the comparison tool prints file basenames only.

## Benchmarks in the quality gate

`npm run check` includes `npm run benchmark:smoke`, a three-case profile with a
single short sample. It is a correctness and determinism check, not a
performance gate: it verifies that the benchmark harness still runs end to end
and that each case reproduces its expected structure and output digest. No
absolute timing is a pass/fail threshold, here or anywhere else in CI.

## Cases

Router construction covers the clean and imperfect reference networks. Router
routing covers the eight cases documented in
[Router reference scenarios](../README.md#router-reference-scenarios), plus a
regular two-way grid in the scaling and stress profiles. Engine cases cover
sparse isolated nodes in 2D and 3D, projection of probes onto a segmented edge,
constraint assessment with forbidden pairs and a tangent-evidence requirement in
3D, a dense neighborhood that exercises deterministic truncation, and — in the
stress profile — an input that deliberately reaches a default engine work limit.

## Reference run

The figures below come from one run of the quick profile on a source checkout,
with manifest version `0.2.0` at source revision
`2c1ee2cc72ec6c486c9764ac48930baad622d026` and a clean worktree. They are a
single data point for interpreting the tables above, not a claim about any other
environment.

Method: 30 measured samples, 3 warmups, and a 100 ms target per sample
(`--runs=30 --warmup=3 --sample-time=100`). Environment: Node.js v24.4.1, V8
13.6.233.10-node.17, Darwin arm64, Apple M1 Max, 10 logical CPUs. Every case
stayed below a 10 percent coefficient of variation.

Router construction, milliseconds per operation:

| Network | Nodes | Segments | Median | p95 | CV % | ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| clean | 73 | 75 | 0.289969 | 0.347658 | 8.69 | 3448.64 |
| imperfect | 74 | 72 | 0.336814 | 0.386529 | 5.56 | 2969.00 |

Router routes, milliseconds per operation:

| Case | Median | p95 | CV % | ops/s |
| --- | ---: | ---: | ---: | ---: |
| case-001 | 0.094023 | 0.104209 | 7.61 | 10635.65 |
| case-002 | 0.042724 | 0.048662 | 6.58 | 23406.18 |
| case-003 | 0.043188 | 0.052512 | 9.83 | 23154.39 |
| case-004 | 0.044866 | 0.051817 | 6.53 | 22288.70 |
| case-005 | 0.061656 | 0.071443 | 6.56 | 16219.13 |
| case-006 | 0.038547 | 0.042123 | 4.84 | 25942.42 |
| case-007 | 0.062225 | 0.065434 | 3.62 | 16070.81 |
| case-008 | 0.077187 | 0.082577 | 4.81 | 12955.61 |

Engine analyses, milliseconds per operation:

| Case | Workload | Median | p95 | CV % | ops/s |
| --- | --- | ---: | ---: | ---: | ---: |
| sparse 2D | 1000 nodes; 7832 neighbor checks; 0 candidates | 7.605771 | 8.677896 | 6.91 | 131.48 |
| sparse 3D | 1000 nodes; 7832 neighbor checks; 0 candidates | 8.630263 | 9.575379 | 4.71 | 115.87 |
| projection 2D | 502 nodes, 1 edge; 7877 neighbor checks; 500 considered, 500 returned | 30.110474 | 33.264255 | 6.13 | 33.21 |
| constraints 3D | 256 nodes, 128 edges; 2112 neighbor checks; 32 review, 32 reject | 6.308390 | 6.998508 | 4.54 | 158.52 |
| dense 2D | 64 nodes; 6112 neighbor checks; 2016 considered, 75 returned, 1941 omitted | 27.694740 | 30.130138 | 4.03 | 36.11 |

## Interpreting the numbers

- These are figures from one machine, one Node.js build, and these fixtures.
  They do not support a universal latency claim, and they say nothing about
  larger networks or about any real dataset.
- Compare only equivalent cases at the same size, with the same output digest
  and the same environment. A changed digest means the two runs did different
  work, so their timings are not comparable.
- Treat a high coefficient of variation as a signal to investigate before
  drawing any conclusion. Background load, thermal state, and power settings all
  show up here; re-run on an idle machine, and raise `--runs` or `--sample-time`
  if the spread stays wide.
- Engine cases scale with neighbor checks and candidate counts, not with node
  count alone. Read the workload column together with the timing.
