import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = await mkdtemp(join(tmpdir(), "gap-router-package-"));

try {
  const packageDirectory = join(temporaryRoot, "package");
  const consumerDirectory = join(temporaryRoot, "consumer");
  await mkdir(packageDirectory);
  await mkdir(consumerDirectory);

  const packed = JSON.parse(execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", packageDirectory],
    {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ));
  assert.equal(packed.length, 1);
  assert.equal(
    packed[0].files.some((file) => file.path === "src/index.d.ts"),
    true,
  );
  assert.equal(
    packed[0].files.some((file) => file.path === "CHANGELOG.md"),
    true,
  );
  assert.equal(
    packed[0].files.some((file) => file.path.startsWith("test/")),
    false,
  );

  const archive = join(packageDirectory, packed[0].filename);
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      archive,
    ],
    {
      cwd: consumerDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    },
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
  execFileSync(process.execPath, ["smoke.mjs"], {
    cwd: consumerDirectory,
    stdio: ["ignore", "pipe", "pipe"],
  });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
