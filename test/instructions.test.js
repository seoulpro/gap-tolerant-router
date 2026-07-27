import assert from "node:assert/strict";
import test from "node:test";

import { buildInstructions } from "../src/index.js";

const leg = (coordinates, extra = {}) => ({
  kind: "network",
  coordinates,
  length: coordinates.length - 1,
  cost: coordinates.length - 1,
  ...extra,
});

const turnModifier = (coordinates) => (
  buildInstructions([leg(coordinates)], {
    minimumEventSpacing: 0,
    turnThresholdDegrees: 10,
  }).find((instruction) => instruction.kind === "turn")?.modifier
);

test("classifies turn direction and severity in Cartesian coordinates", () => {
  assert.equal(
    turnModifier([[0, 0], [10, 0], [20, 10]]),
    "slight-left",
  );
  assert.equal(
    turnModifier([[0, 0], [10, 0], [10, 10]]),
    "left",
  );
  assert.equal(
    turnModifier([[0, 0], [10, 0], [0, 10]]),
    "sharp-left",
  );
  assert.equal(
    turnModifier([[0, 0], [10, 0], [0, 0]]),
    "u-turn",
  );
  assert.equal(
    turnModifier([[0, 0], [10, 0], [10, -10]]),
    "right",
  );
});

test("emits explicit events when a route leaves and resumes the network", () => {
  const instructions = buildInstructions([
    leg([[0, 0], [10, 0]], {
      length: 10,
      cost: 1,
      metadata: { name: "west" },
    }),
    leg([[10, 0], [25, 0]], {
      kind: "gap",
      length: 15,
      cost: 20,
      reason: "nearby-components",
    }),
    leg([[25, 0], [35, 0]], {
      length: 10,
      cost: 1,
      metadata: { name: "east" },
    }),
  ]);

  assert.deepEqual(
    instructions.map((instruction) => instruction.kind),
    ["depart", "leave-network", "resume-network", "arrive"],
  );
  assert.deepEqual(
    instructions.slice(0, -1).map((instruction) => instruction.distance),
    [10, 15, 10],
  );
  assert.equal(instructions[1].reason, "nearby-components");
  assert.deepEqual(instructions[2].metadata, { name: "east" });
});

test("suppresses gap announcements below the configured distance", () => {
  const instructions = buildInstructions([
    leg([[0, 0], [10, 0]], { length: 10 }),
    leg([[10, 0], [15, 0]], {
      kind: "gap",
      length: 5,
      reason: "anchor-snap",
    }),
    leg([[15, 0], [25, 0]], { length: 10 }),
  ]);

  assert.deepEqual(
    instructions.map((instruction) => instruction.kind),
    ["depart", "arrive"],
  );
  assert.equal(instructions[0].distance, 25);
});

test("ignores zero-measure geometry without losing valid spans", () => {
  const instructions = buildInstructions([
    leg([[0, 0], [0, 0]], { length: 0, cost: 0 }),
    leg([[0, 0], [3, 4]], { length: 5, cost: 2 }),
  ]);

  assert.deepEqual(
    instructions.map((instruction) => instruction.kind),
    ["depart", "arrive"],
  );
  assert.equal(instructions[0].distance, 5);
  assert.equal(instructions[0].cost, 2);
});

test("rejects incomplete instruction legs", () => {
  for (const invalid of [
    null,
    [],
    { kind: "network", coordinates: [[0, 0]], length: 0, cost: 0 },
    { kind: "walk", coordinates: [[0, 0], [1, 0]], length: 1, cost: 1 },
    { kind: "network", coordinates: [[0, 0], [1, 0]], length: -1, cost: 1 },
    { kind: "network", coordinates: [[0, 0], [1, 0]], length: 1, cost: -1 },
  ]) {
    assert.throws(
      () => buildInstructions([invalid]),
      /instruction legs|valid geometry/,
    );
  }
});

test("returns no instructions for an empty route", () => {
  assert.deepEqual(buildInstructions([]), []);
});

test("validates instruction collections and option ranges", () => {
  assert.throws(() => buildInstructions(null), /legs must be an array/);
  for (const options of [null, [], "options"]) {
    assert.throws(
      () => buildInstructions([], options),
      /instruction options must be an object/,
    );
  }
  for (const [options, message] of [
    [{ turnThresholdDegrees: Infinity }, /finite angle/],
    [{ uTurnMinDegrees: -1 }, /finite angle/],
    [{ minimumGapInstructionDistance: -1 }, /finite non-negative/],
    [{ minimumEventSpacing: NaN }, /finite non-negative/],
  ]) {
    assert.throws(() => buildInstructions([], options), message);
  }
});
