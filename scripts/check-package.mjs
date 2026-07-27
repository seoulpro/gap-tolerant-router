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
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "package.json",
    "src/index.d.ts",
    "src/index.js",
    "src/instructions.js",
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
  buildInstructions,
  createRouter,
  lineLength,
  projectPointToLine,
} from "gap-tolerant-router";

assert.equal(typeof GapRouter, "function");
assert.equal(typeof createRouter, "function");
assert.equal(typeof buildInstructions, "function");
assert.equal(lineLength([[0, 0], [3, 4]]), 5);
assert.equal(projectPointToLine({ x: 2, y: 1 }, [[0, 0], [4, 0]]).x, 2);

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
