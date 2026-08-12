import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { dirname } from "node:path";
import { hrtime } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { analyzeGaps, GapEngineLimitError } from "../src/engine.js";
import { GapRouter } from "../src/index.js";
import {
  createConstrainedEngineInput,
  createDenseEngineInput,
  createProjectionEngineInput,
  createRouterGridFixture,
  createRouterReferenceFixture,
  createSparseEngineInput,
} from "./fixtures.mjs";

const benchmarkPath = fileURLToPath(import.meta.url);
const repositoryRoot = dirname(dirname(benchmarkPath));
const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const referenceCaseNames = Array.from(
  { length: 8 },
  (_, index) => `router-route-case-${String(index + 1).padStart(3, "0")}`,
);

const profiles = Object.freeze({
  smoke: {
    configuration: { runs: 1, warmup: 0, targetSampleDurationMs: 5 },
    cases: [
      { case: "router-route-case-003", size: 74 },
      { case: "engine-projection-2d", size: 32 },
      { case: "engine-dense-2d", size: 32 },
    ],
  },
  quick: {
    configuration: { runs: 10, warmup: 2, targetSampleDurationMs: 50 },
    cases: [
      { case: "router-build-clean", size: 73 },
      { case: "router-build-imperfect", size: 74 },
      ...referenceCaseNames.map((caseName, index) => ({
        case: caseName,
        size: index === 0 ? 73 : 74,
      })),
      { case: "engine-sparse-2d", size: 1_000 },
      { case: "engine-sparse-3d", size: 1_000 },
      { case: "engine-projection-2d", size: 500 },
      { case: "engine-constraints-3d", size: 64 },
      { case: "engine-dense-2d", size: 64 },
    ],
  },
  scaling: {
    configuration: { runs: 5, warmup: 2, targetSampleDurationMs: 100 },
    cases: [
      ...[256, 1_024, 4_096].flatMap((size) => [
        { case: "router-grid-build", size },
        { case: "router-grid-route", size },
      ]),
      ...[250, 1_000, 4_000].flatMap((size) => [
        { case: "engine-sparse-2d", size },
        { case: "engine-sparse-3d", size },
        { case: "engine-projection-2d", size },
      ]),
      ...[16, 64, 256].map((size) => ({
        case: "engine-constraints-3d",
        size,
      })),
    ],
  },
  stress: {
    configuration: { runs: 5, warmup: 2, targetSampleDurationMs: 100 },
    cases: [
      ...[128, 256, 512].map((size) => ({
        case: "engine-dense-2d",
        size,
      })),
      { case: "engine-default-limit", size: 1_001 },
      { case: "engine-projection-2d", size: 4_000 },
      { case: "router-grid-build", size: 4_096 },
      { case: "router-grid-route", size: 4_096 },
    ],
  },
});

const round = (value, digits = 6) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const digest = (value) => createHash("sha256")
  .update(JSON.stringify(value))
  .digest("hex");

const uniqueGapReasons = (result) => (
  result.ok
    ? [...new Set(
      result.legs
        .filter((leg) => leg.kind === "gap")
        .map((leg) => leg.reason),
    )].sort()
    : []
);

const summarizeRoute = (result) => {
  if (!result.ok) return { ok: false, reason: result.reason };
  return {
    ok: true,
    distance: result.distance,
    cost: result.cost,
    coordinates: result.coordinates.length,
    legs: result.legs.length,
    gapReasons: uniqueGapReasons(result),
    snapDistance: result.snapDistance,
    diagnostics: result.diagnostics,
  };
};

const assertReferenceResult = (scenario, result) => {
  assert.equal(result.ok, scenario.expected.ok, `${scenario.id}: outcome`);
  if (!scenario.expected.ok) {
    assert.equal(result.reason, scenario.expected.reason, `${scenario.id}: reason`);
    return;
  }
  assert.ok(
    Math.abs(result.distance - scenario.expected.distance) <= 1e-9,
    `${scenario.id}: distance changed`,
  );
  assert.deepEqual(
    uniqueGapReasons(result),
    [...scenario.expected.gapReasons].sort(),
    `${scenario.id}: repair reasons changed`,
  );
  if (scenario.expected.mergedNodesAtLeast !== undefined) {
    assert.ok(
      result.diagnostics.mergedNodes >= scenario.expected.mergedNodesAtLeast,
      `${scenario.id}: endpoint merge missing`,
    );
  }
};

const captureRoute = (result) => ({
  digestValue: result,
  summary: summarizeRoute(result),
});

const captureAnalysis = (analysis) => ({
  digestValue: {
    digest: analysis.digest,
    selection: analysis.selection,
    summary: analysis.summary,
    warnings: analysis.warnings,
  },
  summary: {
    analysisDigest: analysis.digest,
    executionComplete: analysis.executionComplete,
    selection: analysis.selection,
    ...analysis.summary,
  },
});

const createReferenceRouteCase = (name) => {
  const fixture = createRouterReferenceFixture();
  const id = name.slice("router-route-".length);
  const scenario = fixture.cases.find((candidate) => candidate.id === id);
  if (!scenario) throw new TypeError(`unknown router reference case: ${name}`);
  const router = new GapRouter(fixture.networks[scenario.network]);
  return {
    category: "router-route",
    description: scenario.label,
    parameters: {
      fixtureSeed: fixture.seed,
      scenario: scenario.id,
      network: scenario.network,
      nodes: fixture.networks[scenario.network].nodes.length,
      segments: fixture.networks[scenario.network].segments.length,
    },
    operation() {
      const result = router.route(
        scenario.start,
        scenario.goal,
        scenario.options,
      );
      assertReferenceResult(scenario, result);
      return result;
    },
    capture: captureRoute,
  };
};

const createReferenceBuildCase = (networkName) => {
  const fixture = createRouterReferenceFixture();
  const network = fixture.networks[networkName];
  const scenario = fixture.cases.find(
    (candidate) => candidate.network === networkName && candidate.expected.ok,
  );
  return {
    category: "router-construction",
    description: `Construct the ${networkName} reference network`,
    parameters: {
      fixtureSeed: fixture.seed,
      network: networkName,
      nodes: network.nodes.length,
      segments: network.segments.length,
    },
    operation: () => new GapRouter(network),
    capture(router) {
      const result = router.route(
        scenario.start,
        scenario.goal,
        scenario.options,
      );
      assertReferenceResult(scenario, result);
      return captureRoute(result);
    },
  };
};

const createGridCase = (name, size) => {
  const fixture = createRouterGridFixture(size);
  const capture = (result) => {
    assert.equal(result.ok, true);
    assert.equal(result.distance, fixture.expectedDistance);
    return captureRoute(result);
  };
  if (name === "router-grid-route") {
    const router = new GapRouter(fixture.input);
    return {
      category: "router-route",
      description: "Route across a regular two-way grid",
      parameters: {
        nodes: fixture.input.nodes.length,
        segments: fixture.input.segments.length,
      },
      operation: () => router.route(
        fixture.start,
        fixture.goal,
        fixture.routeOptions,
      ),
      capture,
    };
  }
  return {
    category: "router-construction",
    description: "Construct a regular two-way grid",
    parameters: {
      nodes: fixture.input.nodes.length,
      segments: fixture.input.segments.length,
    },
    operation: () => new GapRouter(fixture.input),
    capture(router) {
      return capture(router.route(
        fixture.start,
        fixture.goal,
        fixture.routeOptions,
      ));
    },
  };
};

const createEngineCase = (name, size) => {
  let input;
  let description;
  if (name === "engine-sparse-2d") {
    input = createSparseEngineInput(2, size);
    description = "Analyze sparse isolated nodes in 2D";
  } else if (name === "engine-sparse-3d") {
    input = createSparseEngineInput(3, size);
    description = "Analyze sparse isolated nodes in 3D";
  } else if (name === "engine-projection-2d") {
    input = createProjectionEngineInput(size);
    description = "Project isolated probes onto a segmented 2D edge";
  } else if (name === "engine-constraints-3d") {
    input = createConstrainedEngineInput(size);
    description = "Assess review and forbidden-pair candidates in 3D";
  } else if (
    name === "engine-dense-2d"
    || name === "engine-default-limit"
  ) {
    input = createDenseEngineInput(size, {
      useDefaultLimits: name === "engine-default-limit",
    });
    description = name === "engine-dense-2d"
      ? "Analyze a dense, deterministically truncated 2D neighborhood"
      : "Reach a default engine work limit with dense 2D input";
  } else {
    throw new TypeError(`unknown benchmark case: ${name}`);
  }

  const parameters = {
    dimensions: input.snapshot.space.dimensions,
    nodes: input.snapshot.nodes.length,
    edges: input.snapshot.edges.length,
    totalPoints: input.snapshot.nodes.length + input.snapshot.edges.reduce(
      (total, edge) => total + edge.geometry.length,
      0,
    ),
  };

  if (name === "engine-default-limit") {
    return {
      category: "engine-limit",
      description,
      parameters,
      operation() {
        try {
          analyzeGaps(input);
        } catch (error) {
          if (!(error instanceof GapEngineLimitError)) throw error;
          assert.match(error.code, /^MAX_[A-Z_]+$/);
          return {
            name: error.name,
            code: error.code,
            phase: error.phase,
            limit: error.limit,
            actual: error.actual,
          };
        }
        throw new Error("expected a default engine work limit");
      },
      capture(value) {
        return { digestValue: value, summary: value };
      },
    };
  }

  return {
    category: "engine-analysis",
    description,
    parameters,
    operation: () => analyzeGaps(input),
    capture: captureAnalysis,
  };
};

const createBenchmarkCase = (name, size) => {
  if (referenceCaseNames.includes(name)) return createReferenceRouteCase(name);
  if (name === "router-build-clean") return createReferenceBuildCase("clean");
  if (name === "router-build-imperfect") {
    return createReferenceBuildCase("imperfect");
  }
  if (name === "router-grid-build" || name === "router-grid-route") {
    return createGridCase(name, size);
  }
  if (name.startsWith("engine-")) return createEngineCase(name, size);
  throw new TypeError(`unknown benchmark case: ${name}`);
};

const captureOutput = (benchmarkCase, value) => {
  const captured = benchmarkCase.capture(value);
  return {
    digest: digest(captured.digestValue),
    summary: captured.summary,
  };
};

const elapsedMilliseconds = (startedAt) => (
  Number(hrtime.bigint() - startedAt) / 1_000_000
);

const measureOperations = (operation, operationCount) => {
  const startedAt = hrtime.bigint();
  let value;
  for (let index = 0; index < operationCount; index += 1) {
    value = operation();
  }
  return { elapsedMs: elapsedMilliseconds(startedAt), value };
};

const percentile = (sorted, ratio) => {
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

const calculateStatistics = (samples) => {
  const sorted = samples.slice().sort((left, right) => left - right);
  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  const variance = samples.length === 1
    ? 0
    : samples.reduce((total, value) => total + (value - mean) ** 2, 0)
      / (samples.length - 1);
  const standardDeviation = Math.sqrt(variance);
  const medianMs = percentile(sorted, 0.5);
  return {
    minMs: round(sorted[0]),
    medianMs: round(medianMs),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1)),
    meanMs: round(mean),
    standardDeviationMs: round(standardDeviation),
    coefficientOfVariationPercent: round(
      mean === 0 ? 0 : standardDeviation / mean * 100,
      2,
    ),
    operationsPerSecond: round(1_000 / medianMs, 2),
  };
};

const runWorker = ({ caseName, size, runs, warmup, targetSampleDurationMs }) => {
  const benchmarkCase = createBenchmarkCase(caseName, size);
  const baseline = captureOutput(benchmarkCase, benchmarkCase.operation());

  for (let index = 0; index < warmup; index += 1) {
    const output = captureOutput(benchmarkCase, benchmarkCase.operation());
    assert.equal(output.digest, baseline.digest, `${caseName}: warmup output`);
  }

  const calibrationTargetMs = Math.max(1, targetSampleDurationMs / 5);
  let calibrationOperations = 1;
  let calibration;
  do {
    calibration = measureOperations(
      benchmarkCase.operation,
      calibrationOperations,
    );
    const output = captureOutput(benchmarkCase, calibration.value);
    assert.equal(output.digest, baseline.digest, `${caseName}: calibration output`);
    if (calibration.elapsedMs >= calibrationTargetMs) break;
    calibrationOperations *= 2;
  } while (calibrationOperations <= 10_000);

  const operationsPerSample = Math.max(
    1,
    Math.min(
      10_000,
      Math.ceil(
        calibrationOperations
          * targetSampleDurationMs
          / Math.max(calibration.elapsedMs, Number.EPSILON),
      ),
    ),
  );

  const samplesMs = [];
  for (let index = 0; index < runs; index += 1) {
    const sample = measureOperations(
      benchmarkCase.operation,
      operationsPerSample,
    );
    const output = captureOutput(benchmarkCase, sample.value);
    assert.equal(output.digest, baseline.digest, `${caseName}: sample output`);
    samplesMs.push(sample.elapsedMs / operationsPerSample);
  }

  return {
    case: caseName,
    category: benchmarkCase.category,
    description: benchmarkCase.description,
    size,
    parameters: benchmarkCase.parameters,
    operationsPerSample,
    targetSampleDurationMs,
    samplesMs: samplesMs.map((value) => round(value)),
    statistics: calculateStatistics(samplesMs),
    output: baseline,
  };
};

const positiveInteger = (value, name, { allowZero = false } = {}) => {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || (allowZero ? parsed < 0 : parsed <= 0)
  ) {
    throw new TypeError(
      `${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`,
    );
  }
  return parsed;
};

const positiveNumber = (value, name) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return parsed;
};

const options = parseArgs({
  allowPositionals: false,
  strict: true,
  options: {
    profile: { type: "string", default: "quick" },
    case: { type: "string", multiple: true },
    sizes: { type: "string" },
    size: { type: "string" },
    runs: { type: "string" },
    warmup: { type: "string" },
    "sample-time": { type: "string" },
    json: { type: "boolean", default: false },
    worker: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
}).values;

const usage = `Usage: node benchmark/run.mjs [options]

Options:
  --profile=<smoke|quick|scaling|stress>  Select a predefined profile
  --case=<name>                           Select a case (repeatable)
  --sizes=<n,n,...>                       Filter selected case sizes
  --runs=<n>                              Measured samples per case
  --warmup=<n>                            Warmup operations per case
  --sample-time=<ms>                      Target duration of each sample
  --json                                  Emit a machine-readable report
  --help                                  Show this help`;

if (options.help) {
  console.log(usage);
} else if (options.worker) {
  const caseName = options.case?.at(-1);
  if (!caseName) throw new TypeError("worker requires --case");
  const result = runWorker({
    caseName,
    size: positiveInteger(options.size, "size"),
    runs: positiveInteger(options.runs, "runs"),
    warmup: positiveInteger(options.warmup, "warmup", { allowZero: true }),
    targetSampleDurationMs: positiveNumber(
      options["sample-time"],
      "sample-time",
    ),
  });
  process.stdout.write(JSON.stringify(result));
} else {
  const profile = profiles[options.profile];
  if (!profile) throw new TypeError(`unknown benchmark profile: ${options.profile}`);
  const requestedCases = options.case ?? [];
  const requestedSizes = options.sizes === undefined
    ? null
    : new Set(options.sizes.split(",").map(
      (value) => positiveInteger(value, "sizes"),
    ));
  const selected = profile.cases.filter((configuration) => (
    (requestedCases.length === 0 || requestedCases.includes(configuration.case))
    && (requestedSizes === null || requestedSizes.has(configuration.size))
  ));
  if (selected.length === 0) {
    throw new TypeError("no benchmark cases match the requested profile and filters");
  }

  const configuration = {
    runs: options.runs === undefined
      ? profile.configuration.runs
      : positiveInteger(options.runs, "runs"),
    warmup: options.warmup === undefined
      ? profile.configuration.warmup
      : positiveInteger(options.warmup, "warmup", { allowZero: true }),
    targetSampleDurationMs: options["sample-time"] === undefined
      ? profile.configuration.targetSampleDurationMs
      : positiveNumber(options["sample-time"], "sample-time"),
  };

  const results = selected.map(({ case: caseName, size }) => {
    const worker = spawnSync(process.execPath, [
      benchmarkPath,
      "--worker",
      `--case=${caseName}`,
      `--size=${size}`,
      `--runs=${configuration.runs}`,
      `--warmup=${configuration.warmup}`,
      `--sample-time=${configuration.targetSampleDurationMs}`,
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1_024 * 1_024,
    });
    if (worker.status !== 0) {
      throw new Error([
        `${caseName}:${size} benchmark worker failed`,
        worker.stdout,
        worker.stderr,
      ].filter(Boolean).join("\n"));
    }
    return JSON.parse(worker.stdout);
  });

  const gitRevision = spawnSync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const gitStatus = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const cpuList = cpus();
  const report = {
    schemaVersion: 1,
    suite: "gap-tolerant-router",
    packageVersion: packageMetadata.version,
    profile: options.profile,
    configuration,
    environment: {
      node: process.version,
      v8: process.versions.v8,
      platform: platform(),
      architecture: arch(),
      cpu: cpuList[0]?.model ?? "unknown",
      logicalCpuCount: cpuList.length,
    },
    source: {
      revision: gitRevision.status === 0
        ? gitRevision.stdout.trim()
        : null,
      dirty: gitStatus.status === 0 ? gitStatus.stdout.length > 0 : null,
    },
    results,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(
      `${report.suite} ${report.packageVersion} — ${report.profile} profile`,
    );
    console.table(results.map((result) => ({
      case: result.case,
      size: result.size,
      "median ms": result.statistics.medianMs,
      "p95 ms": result.statistics.p95Ms,
      "CV %": result.statistics.coefficientOfVariationPercent,
      "ops/s": result.statistics.operationsPerSecond,
      output: result.output.digest.slice(0, 12),
    })));
    console.log(
      "Compare timings only across equivalent cases, output digests, and environments.",
    );
  }
}
