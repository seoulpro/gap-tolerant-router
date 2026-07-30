import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = await mkdtemp(join(tmpdir(), "gap-router-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const run = (command, args, cwd) => {
  const environment = {
    ...process.env,
    NO_UPDATE_NOTIFIER: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  delete environment.npm_config_dry_run;
  delete environment.NPM_CONFIG_DRY_RUN;

  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed`,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join("\n"),
    );
  }
  return result.stdout;
};

try {
  const packageDirectory = join(temporaryRoot, "package");
  const consumerDirectory = join(temporaryRoot, "consumer");
  await mkdir(packageDirectory);
  await mkdir(consumerDirectory);

  const packed = JSON.parse(run(
    npm,
    ["pack", "--json", "--pack-destination", packageDirectory],
    projectRoot,
  ));
  assert.equal(packed.length, 1);
  const packedPaths = new Set(packed[0].files.map((file) => file.path));
  for (const expected of [
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "examples/industrial-conformance/amr-missing-heading.json",
    "examples/industrial-conformance/biomedical-morphology-3d.json",
    "examples/industrial-conformance/process-forbidden-tie-in.json",
    "examples/industrial-conformance/utility-distribution-gap.json",
    "examples/run-industrial-conformance.mjs",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "package.json",
    "src/engine.d.ts",
    "src/engine.js",
    "src/index.d.ts",
    "src/index.js",
    "src/instructions.js",
    "src/numerics.js",
    "src/router.js",
  ]) {
    assert.equal(
      packedPaths.has(expected),
      true,
      `package is missing ${expected}`,
    );
  }
  for (const path of packedPaths) {
    assert.equal(path.startsWith(".github/"), false);
    assert.equal(path.startsWith("scripts/"), false);
    assert.equal(path.startsWith("test/"), false);
    assert.equal(path.startsWith("test-d/"), false);
  }

  const archive = join(packageDirectory, packed[0].filename);
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  run(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      archive,
    ],
    consumerDirectory,
  );
  await writeFile(
    join(consumerDirectory, "smoke.mjs"),
    `import assert from "node:assert/strict";
import {
  GapRouter,
  RouterLimitError,
  buildInstructions,
  createRouter,
  lineLength,
  projectPointToLine,
} from "gap-tolerant-router";
import {
  GapAnalysisEngine,
  GapEngineLimitError,
  analyzeGaps,
  createGapEngine,
} from "gap-tolerant-router/engine";

assert.equal(typeof GapRouter, "function");
assert.equal(typeof RouterLimitError, "function");
assert.equal(typeof createRouter, "function");
assert.equal(typeof buildInstructions, "function");
assert.equal(lineLength([[0, 0], [3, 4]]), 5);
assert.equal(projectPointToLine({ x: 2, y: 1 }, [[0, 0], [4, 0]]).x, 2);
assert.equal(typeof GapAnalysisEngine, "function");
assert.equal(typeof GapEngineLimitError, "function");
assert.equal(typeof createGapEngine, "function");
assert.equal(typeof analyzeGaps, "function");

const router = createRouter({
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 10, y: 0 },
  ],
  segments: [{
    id: "line",
    from: "a",
    to: "b",
    coordinates: [[0, 0], [10, 0]],
  }],
  options: { maxGapDistance: 0, mergeTolerance: 0 },
});
const route = router.route(
  { x: 1, y: 0 },
  { x: 9, y: 0 },
  { maxSnapDistance: 0 },
);
assert.equal(route.ok, true);
assert.equal(route.distance, 8);

const analysis = analyzeGaps({
  snapshot: {
    schema: "gtr.network/v1",
    networkId: "smoke",
    revision: "r1",
    space: { dimensions: 2, unit: "m", frame: "local" },
    nodes: [
      { id: "a", position: [0, 0] },
      { id: "b", position: [1, 0] },
    ],
    edges: [],
  },
  proposal: {
    includeEndpointToEdge: false,
    maxGapDistance: 2,
  },
});
assert.equal(analysis.executionComplete, true);
assert.equal(analysis.candidates[0].assessment.status, "abstain");
`,
  );
  run(process.execPath, ["smoke.mjs"], consumerDirectory);

  const installedManifest = JSON.parse(await readFile(
    join(
      consumerDirectory,
      "node_modules",
      "gap-tolerant-router",
      "package.json",
    ),
    "utf8",
  ));
  assert.equal(installedManifest.version, packed[0].version);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
