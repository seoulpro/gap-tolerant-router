import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";

const readReport = (path) => {
  const report = JSON.parse(readFileSync(path, "utf8"));
  if (
    report.schemaVersion !== 1
    || report.suite !== "gap-tolerant-router"
    || !Array.isArray(report.results)
  ) {
    throw new TypeError(`${path} is not a supported benchmark report`);
  }
  return report;
};

const resultKey = (result) => `${result.case}:${result.size}`;

const differingFields = (left, right, fields) => fields.filter(
  (field) => left[field] !== right[field],
);

const formatChange = (baseline, candidate) => {
  if (baseline === 0) return candidate === 0 ? "0.00%" : "n/a";
  const percent = (candidate / baseline - 1) * 100;
  if (Math.abs(percent) < 0.005) return "0.00%";
  return `${percent > 0 ? "+" : ""}${percent.toFixed(2)}%`;
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: true,
  options: {
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const usage = "Usage: node benchmark/compare.mjs [--json] <baseline.json> <candidate.json>";

if (values.help) {
  console.log(usage);
} else {
  if (positionals.length !== 2) throw new TypeError(usage);
  const [baselinePath, candidatePath] = positionals;
  const baseline = readReport(baselinePath);
  const candidate = readReport(candidatePath);
  const warnings = [];

  const environmentFields = [
    "node",
    "v8",
    "platform",
    "architecture",
    "cpu",
    "logicalCpuCount",
  ];
  const environmentDifferences = differingFields(
    baseline.environment,
    candidate.environment,
    environmentFields,
  );
  if (environmentDifferences.length > 0) {
    warnings.push(
      `environment differs in ${environmentDifferences.join(", ")}`,
    );
  }

  const configurationFields = [
    "runs",
    "warmup",
    "targetSampleDurationMs",
  ];
  const configurationDifferences = differingFields(
    baseline.configuration,
    candidate.configuration,
    configurationFields,
  );
  if (configurationDifferences.length > 0) {
    warnings.push(
      `configuration differs in ${configurationDifferences.join(", ")}`,
    );
  }
  if (baseline.profile !== candidate.profile) {
    warnings.push(`profile differs: ${baseline.profile} vs ${candidate.profile}`);
  }

  const candidateByKey = new Map(
    candidate.results.map((result) => [resultKey(result), result]),
  );
  const results = baseline.results.map((before) => {
    const key = resultKey(before);
    const after = candidateByKey.get(key);
    if (!after) throw new TypeError(`candidate report is missing ${key}`);
    if (JSON.stringify(before.parameters) !== JSON.stringify(after.parameters)) {
      throw new TypeError(`benchmark parameters differ for ${key}`);
    }
    candidateByKey.delete(key);
    return {
      case: before.case,
      size: before.size,
      baselineMedianMs: before.statistics.medianMs,
      candidateMedianMs: after.statistics.medianMs,
      medianChange: formatChange(
        before.statistics.medianMs,
        after.statistics.medianMs,
      ),
      baselineCvPercent: before.statistics.coefficientOfVariationPercent,
      candidateCvPercent: after.statistics.coefficientOfVariationPercent,
      output: before.output.digest === after.output.digest ? "same" : "changed",
      baselineOutputDigest: before.output.digest,
      candidateOutputDigest: after.output.digest,
    };
  });
  if (candidateByKey.size > 0) {
    throw new TypeError(
      `candidate report has extra results: ${[...candidateByKey.keys()].join(", ")}`,
    );
  }

  const comparison = {
    schemaVersion: 1,
    suite: baseline.suite,
    baseline: {
      file: basename(baselinePath),
      packageVersion: baseline.packageVersion,
      revision: baseline.source?.revision ?? null,
    },
    candidate: {
      file: basename(candidatePath),
      packageVersion: candidate.packageVersion,
      revision: candidate.source?.revision ?? null,
    },
    warnings,
    results,
  };

  if (values.json) {
    process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
  } else {
    console.log(
      `${comparison.suite}: ${comparison.baseline.file} -> ${comparison.candidate.file}`,
    );
    for (const warning of warnings) console.warn(`Warning: ${warning}`);
    console.table(results.map((result) => ({
      case: result.case,
      size: result.size,
      "before ms": result.baselineMedianMs,
      "after ms": result.candidateMedianMs,
      change: result.medianChange,
      "before CV %": result.baselineCvPercent,
      "after CV %": result.candidateCvPercent,
      output: result.output,
    })));
    console.log(
      "Positive timing change is slower. Deltas are descriptive, not a statistical significance claim.",
    );
  }
}
