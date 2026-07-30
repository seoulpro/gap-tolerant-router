import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

import { analyzeGaps } from "../src/engine.js";

const directory = new URL("./industrial-conformance/", import.meta.url);
const names = (await readdir(directory))
  .filter((name) => name.endsWith(".json"))
  .sort();
const rows = [];

for (const name of names) {
  const fixture = JSON.parse(
    await readFile(new URL(name, directory), "utf8"),
  );
  const analysis = analyzeGaps(fixture.input);
  assert.equal(analysis.candidates.length, fixture.expected.candidateCount);
  const [candidate] = analysis.candidates;
  assert.equal(candidate.id, fixture.expected.candidateId);
  assert.deepEqual(candidate.operation, fixture.expected.operation);
  assert.equal(candidate.features.distance, fixture.expected.distance);
  assert.equal(candidate.assessment.status, fixture.expected.status);
  rows.push({
    id: fixture.id,
    kind: candidate.operation.kind,
    status: candidate.assessment.status,
    distance: `${candidate.features.distance} ${
      fixture.input.snapshot.space.unit
    }`,
    boundary: fixture.scopeBoundary,
  });
}

console.log("| Fixture | Candidate | Status | Distance | Scope boundary |");
console.log("| --- | --- | --- | ---: | --- |");
for (const row of rows) {
  console.log(
    `| ${row.id} | ${row.kind} | ${row.status} | ${
      row.distance
    } | ${row.boundary} |`,
  );
}
