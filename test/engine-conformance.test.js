import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { analyzeGaps } from "../src/engine.js";

const fixtureDirectory = new URL(
  "../examples/industrial-conformance/",
  import.meta.url,
);
const fixtureNames = readdirSync(fixtureDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort();

assert.deepEqual(fixtureNames, [
  "amr-missing-heading.json",
  "biomedical-morphology-3d.json",
  "process-forbidden-tie-in.json",
  "utility-distribution-gap.json",
]);

for (const fixtureName of fixtureNames) {
  test(`matches industrial conformance fixture: ${fixtureName}`, () => {
    const fixture = JSON.parse(
      readFileSync(new URL(fixtureName, fixtureDirectory), "utf8"),
    );
    assert.equal(fixture.fixtureVersion, 1);
    assert.deepEqual(fixture.provenance, {
      origin: "fully-synthetic",
      containsRealOperationalData: false,
      containsPersonalOrClinicalData: false,
    });
    assert.ok(fixture.scopeBoundary.length > 40);

    const analysis = analyzeGaps(fixture.input);
    assert.deepEqual(analysis.algorithm, {
      id: "gtr-geometry-proposal",
      version: "1",
      numericProfile: "binary64-geometry-significant-15-alignments",
    });
    assert.equal(analysis.executionComplete, true);
    assert.deepEqual(analysis.selection, {
      policy: "per-endpoint-union",
      truncated: false,
      omitted: 0,
      maxCandidatesPerEndpoint: 4,
    });
    assert.deepEqual(analysis.warnings, [
      "Geometry-only assessments are not calibrated probabilities.",
      "Review status does not authorize graph mutation or routing.",
    ]);
    assert.equal(
      analysis.candidates.length,
      fixture.expected.candidateCount,
    );

    const [candidate] = analysis.candidates;
    assert.equal(candidate.id, fixture.expected.candidateId);
    assert.deepEqual(candidate.operation, fixture.expected.operation);
    assert.deepEqual(candidate.geometry, fixture.expected.geometry);
    assert.equal(candidate.features.distance, fixture.expected.distance);
    assert.equal(candidate.assessment.status, fixture.expected.status);
    assert.deepEqual(
      candidate.assessment.reasonCodes,
      fixture.expected.reasonCodes,
    );
    assert.deepEqual(
      candidate.assessment.constraintResults,
      fixture.expected.constraintResults,
    );
    assert.equal(Object.hasOwn(candidate, "confidence"), false);
    assert.equal(Object.hasOwn(candidate, "probability"), false);
    assert.equal(analysis.summary.candidatesConsidered, 1);
    assert.equal(analysis.summary.candidatesReturned, 1);
    assert.equal(analysis.summary.statusCounts[fixture.expected.status], 1);
  });
}
