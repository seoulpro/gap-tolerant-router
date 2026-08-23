import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const compare = fileURLToPath(
  new URL("../benchmark/compare.mjs", import.meta.url),
);

const report = (digest) => ({
  schemaVersion: 1,
  suite: "gap-tolerant-router",
  packageVersion: "0.0.0-test",
  profile: "smoke",
  environment: {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    architecture: process.arch,
    cpu: "fixture",
    logicalCpuCount: 1,
  },
  configuration: {
    runs: 1,
    warmup: 0,
    targetSampleDurationMs: 1,
  },
  source: { revision: null },
  results: [{
    case: "fixture",
    size: 1,
    parameters: { input: "fixed" },
    statistics: { medianMs: 1, coefficientOfVariationPercent: 0 },
    output: { digest },
  }],
});

test("benchmark comparison can fail CI when output digests change", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "gap-router-compare-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const baseline = join(directory, "baseline.json");
  const same = join(directory, "same.json");
  const changed = join(directory, "changed.json");
  await Promise.all([
    writeFile(baseline, JSON.stringify(report("aaa"))),
    writeFile(same, JSON.stringify(report("aaa"))),
    writeFile(changed, JSON.stringify(report("bbb"))),
  ]);

  const run = (...arguments_) => spawnSync(
    process.execPath,
    [compare, "--json", "--fail-on-output-change", ...arguments_],
    { encoding: "utf8" },
  );
  assert.equal(run(baseline, same).status, 0);
  const mismatch = run(baseline, changed);
  assert.equal(mismatch.status, 1);
  assert.equal(JSON.parse(mismatch.stdout).results[0].output, "changed");

  const descriptive = spawnSync(
    process.execPath,
    [compare, "--json", baseline, changed],
    { encoding: "utf8" },
  );
  assert.equal(descriptive.status, 0);
});
