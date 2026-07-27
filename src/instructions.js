const DEFAULTS = Object.freeze({
  turnThresholdDegrees: 25,
  slightTurnMaxDegrees: 45,
  sharpTurnMinDegrees: 120,
  uTurnMinDegrees: 160,
  minimumGapInstructionDistance: 12,
  minimumEventSpacing: 8,
});
const OPTION_NAMES = new Set(Object.keys(DEFAULTS));

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const bearing = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;

const bearingDelta = (from, to) => {
  let delta = to - from;
  while (delta <= -180) delta += 360;
  while (delta > 180) delta -= 360;
  return delta;
};

const modifier = (delta, options) => {
  const magnitude = Math.abs(delta);
  if (magnitude < options.turnThresholdDegrees) return null;
  const side = delta > 0 ? "left" : "right";
  if (magnitude >= options.uTurnMinDegrees) return "u-turn";
  if (magnitude >= options.sharpTurnMinDegrees) return `sharp-${side}`;
  if (magnitude <= options.slightTurnMaxDegrees) return `slight-${side}`;
  return side;
};

const normalizeOptions = (overrides) => {
  if (
    typeof overrides !== "object"
    || overrides === null
    || Array.isArray(overrides)
  ) {
    throw new TypeError("instruction options must be an object");
  }
  for (const name of Object.keys(overrides)) {
    if (!OPTION_NAMES.has(name)) {
      throw new TypeError(`unknown instruction option: ${name}`);
    }
  }
  const options = { ...DEFAULTS, ...overrides };
  for (const name of [
    "turnThresholdDegrees",
    "slightTurnMaxDegrees",
    "sharpTurnMinDegrees",
    "uTurnMinDegrees",
  ]) {
    if (
      !Number.isFinite(options[name])
      || options[name] < 0
      || options[name] > 180
    ) {
      throw new TypeError(`${name} must be a finite angle from 0 to 180`);
    }
  }
  if (
    options.turnThresholdDegrees > options.slightTurnMaxDegrees
    || options.slightTurnMaxDegrees > options.sharpTurnMinDegrees
    || options.sharpTurnMinDegrees > options.uTurnMinDegrees
  ) {
    throw new TypeError("instruction angle thresholds must be ordered");
  }
  for (const name of [
    "minimumGapInstructionDistance",
    "minimumEventSpacing",
  ]) {
    if (!Number.isFinite(options[name]) || options[name] < 0) {
      throw new TypeError(`${name} must be a finite non-negative number`);
    }
  }
  return options;
};

export const buildInstructions = (legs, overrides = {}) => {
  if (!Array.isArray(legs)) {
    throw new TypeError("legs must be an array");
  }
  const options = normalizeOptions(overrides);
  const spans = [];
  for (const leg of legs) {
    if (typeof leg !== "object" || leg === null || Array.isArray(leg)) {
      throw new TypeError("instruction legs must be objects");
    }
    if (
      (leg.kind !== "network" && leg.kind !== "gap")
      || !Number.isFinite(leg.length)
      || leg.length < 0
      || !Number.isFinite(leg.cost)
      || leg.cost < 0
      || !Array.isArray(leg.coordinates)
      || leg.coordinates.length < 2
      || leg.coordinates.some(
        (coordinate) =>
          !Array.isArray(coordinate)
          || coordinate.length < 2
          || !Number.isFinite(coordinate[0])
          || !Number.isFinite(coordinate[1])
      )
    ) {
      throw new TypeError(
        "instruction legs must contain valid geometry, length, cost, and kind",
      );
    }
    const measured = leg.coordinates
      .slice(1)
      .reduce((sum, point, index) => sum + distance(leg.coordinates[index], point), 0);
    if (measured <= 0) continue;
    for (let index = 1; index < leg.coordinates.length; index += 1) {
      const from = leg.coordinates[index - 1];
      const to = leg.coordinates[index];
      const measuredSpan = distance(from, to);
      if (measuredSpan <= 0) continue;
      spans.push({
        from,
        to,
        distance: measuredSpan / measured * leg.length,
        cost: measuredSpan / measured * leg.cost,
        gap: leg.kind === "gap"
          && leg.length >= options.minimumGapInstructionDistance,
        reason: leg.reason ?? null,
        metadata: leg.metadata ?? null,
      });
    }
  }
  if (spans.length === 0) return [];

  const instructions = [];
  const add = (instruction) => {
    const previous = instructions.at(-1);
    if (
      previous
      && previous.kind === "turn"
      && instruction.kind === "turn"
      && previous.distance < options.minimumEventSpacing
    ) {
      if (Math.abs(instruction.angle) > Math.abs(previous.angle)) {
        const beforePrevious = instructions.at(-2);
        if (beforePrevious) {
          beforePrevious.distance += previous.distance;
          beforePrevious.cost += previous.cost;
        }
        Object.assign(previous, instruction);
      }
      return previous;
    }
    instructions.push(instruction);
    return instruction;
  };

  const first = spans[0];
  let current = add({
    kind: first.gap ? "leave-network" : "depart",
    modifier: null,
    reason: first.reason,
    metadata: first.metadata,
    distance: 0,
    cost: 0,
    at: { x: first.from[0], y: first.from[1] },
    angle: 0,
  });
  let previousSpan = first;
  let previousBearing = bearing(first.from, first.to);

  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index];
    if (index > 0) {
      const nextBearing = bearing(span.from, span.to);
      if (span.gap && !previousSpan.gap) {
        current = add({
          kind: "leave-network",
          modifier: null,
          reason: span.reason,
          metadata: null,
          distance: 0,
          cost: 0,
          at: { x: span.from[0], y: span.from[1] },
          angle: 0,
        });
      } else if (!span.gap && previousSpan.gap) {
        current = add({
          kind: "resume-network",
          modifier: null,
          reason: null,
          metadata: span.metadata,
          distance: 0,
          cost: 0,
          at: { x: span.from[0], y: span.from[1] },
          angle: 0,
        });
      } else if (!span.gap) {
        const angle = bearingDelta(previousBearing, nextBearing);
        const turn = modifier(angle, options);
        if (turn) {
          current = add({
            kind: "turn",
            modifier: turn,
            reason: null,
            metadata: span.metadata,
            distance: 0,
            cost: 0,
            at: { x: span.from[0], y: span.from[1] },
            angle,
          });
        }
      }
      previousBearing = nextBearing;
    }
    current.distance += span.distance;
    current.cost += span.cost;
    previousSpan = span;
  }

  const last = spans.at(-1);
  instructions.push({
    kind: "arrive",
    modifier: null,
    reason: null,
    metadata: null,
    distance: 0,
    cost: 0,
    at: { x: last.to[0], y: last.to[1] },
    angle: 0,
  });
  return instructions.map(({ angle: _angle, ...instruction }) => ({
    ...instruction,
    distance: Math.round(instruction.distance * 1_000) / 1_000,
    cost: Math.round(instruction.cost * 1_000) / 1_000,
  }));
};
