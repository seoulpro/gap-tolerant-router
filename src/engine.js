import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import { robustProjection } from "./numerics.js";

const NETWORK_SCHEMA = "gtr.network/v1";
const ANALYSIS_SCHEMA = "gtr.analysis/v1";
const ALGORITHM = Object.freeze({
  id: "gtr-geometry-proposal",
  version: "1",
  numericProfile: "binary64-geometry-significant-15-alignments",
});
const STATUS_ORDER = Object.freeze({
  review: 0,
  abstain: 1,
  reject: 2,
});
const DEFAULT_PROPOSAL = Object.freeze({
  maxGapDistance: 0,
  maxCandidatesPerEndpoint: 8,
  includeEndpointToEdge: true,
  requireDifferentComponents: true,
  requireTangentEvidence: true,
});
const DEFAULT_LIMITS = Object.freeze({
  maxNodes: 25_000,
  maxEdges: 25_000,
  maxTotalPoints: 100_000,
  maxPropertyFields: 25_000,
  maxPropertyBytes: 1_000_000,
  maxStringBytes: 1_000_000,
  maxConstraintPairs: 25_000,
  maxNeighborChecks: 500_000,
  maxCandidatesTotal: 10_000,
  maxOutputBytes: 16_000_000,
});
const PROPOSAL_KEYS = new Set(Object.keys(DEFAULT_PROPOSAL));
const LIMIT_KEYS = new Set(Object.keys(DEFAULT_LIMITS));
const INPUT_KEYS = new Set([
  "snapshot",
  "proposal",
  "constraints",
  "limits",
]);
const SNAPSHOT_KEYS = new Set([
  "schema",
  "networkId",
  "revision",
  "space",
  "nodes",
  "edges",
]);
const SPACE_KEYS = new Set([
  "dimensions",
  "unit",
  "frame",
  "metric",
]);
const NODE_KEYS = new Set(["id", "position", "properties"]);
const EDGE_KEYS = new Set([
  "id",
  "from",
  "to",
  "geometry",
  "direction",
  "properties",
]);
const CONSTRAINT_KEYS = new Set([
  "forbiddenNodePairs",
  "forbiddenNodeEdgePairs",
]);
const PROPERTY_FORBIDDEN_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const JSON_ESCAPES = Object.freeze({
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0c: "\\f",
  0x0d: "\\r",
  0x22: "\\\"",
  0x5c: "\\\\",
});
const MAX_SCHEMA_RECORD_FIELDS = 64;

const LIMIT_CODES = Object.freeze({
  maxNodes: "MAX_NODES",
  maxEdges: "MAX_EDGES",
  maxTotalPoints: "MAX_TOTAL_POINTS",
  maxPropertyFields: "MAX_PROPERTY_FIELDS",
  maxPropertyBytes: "MAX_PROPERTY_BYTES",
  maxStringBytes: "MAX_STRING_BYTES",
  maxConstraintPairs: "MAX_CONSTRAINT_PAIRS",
  maxNeighborChecks: "MAX_NEIGHBOR_CHECKS",
  maxCandidatesTotal: "MAX_CANDIDATES_TOTAL",
  maxOutputBytes: "MAX_OUTPUT_BYTES",
});

export class GapEngineLimitError extends RangeError {
  constructor(code, phase, limit, actual) {
    super(`gap engine execution limit exceeded: ${code}`);
    this.name = "GapEngineLimitError";
    this.code = code;
    this.phase = phase;
    this.limit = limit;
    this.actual = actual;
  }
}

const isPlainRecord = (value) => {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || utilTypes.isProxy(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const assertRecord = (value, label) => {
  if (!isPlainRecord(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const copy = Object.create(null);
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_SCHEMA_RECORD_FIELDS) {
    throw new TypeError(`${label} contains too many fields`);
  }
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} must not contain symbol keys`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} must not contain accessors`);
    }
    if (!descriptor.enumerable) {
      throw new TypeError(`${label} must not contain non-enumerable fields`);
    }
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  return copy;
};

const dataArrayLength = (value, label) => {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !descriptor
    || !Object.hasOwn(descriptor, "value")
    || !Number.isSafeInteger(descriptor.value)
    || descriptor.value < 0
  ) {
    throw new TypeError(`${label} must have a valid length`);
  }
  return descriptor.value;
};

const copyDenseArray = (value, label) => {
  const length = dataArrayLength(value, label);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1) {
    throw new TypeError(`${label} must not contain extra properties`);
  }
  const copy = [];
  const allowedKeys = new Set(["length"]);
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    allowedKeys.add(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || !descriptor.enumerable
    ) {
      throw new TypeError(
        `${label} must be a dense array of data elements`,
      );
    }
    copy.push(descriptor.value);
  }
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} must not contain symbol keys`);
    }
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${label} must not contain extra properties`);
    }
  }
  return copy;
};

const assertKnownKeys = (value, allowed, label) => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`unknown ${label} field`);
    }
  }
};

const nonEmptyString = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
};

const finiteNonNegative = (value, label) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return value;
};

const safeNonNegativeInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
};

const enforceLimit = (limits, name, phase, actual) => {
  const limit = limits[name];
  if (actual > limit) {
    throw new GapEngineLimitError(
      LIMIT_CODES[name],
      phase,
      limit,
      actual,
    );
  }
};

const updateCanonicalString = (hash, value) => {
  hash.update("\"");
  let chunkStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let escape;
    if (Object.hasOwn(JSON_ESCAPES, code)) {
      escape = JSON_ESCAPES[code];
    } else if (code <= 0x1f) {
      escape = `\\u${code.toString(16).padStart(4, "0")}`;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      escape = `\\u${code.toString(16).padStart(4, "0")}`;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      escape = `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      continue;
    }
    if (index > chunkStart) hash.update(value.slice(chunkStart, index));
    hash.update(escape);
    chunkStart = index + 1;
  }
  if (chunkStart < value.length) hash.update(value.slice(chunkStart));
  hash.update("\"");
};

const updateCanonicalHash = (hash, value) => {
  if (value === null) {
    hash.update("null");
    return;
  }
  if (typeof value === "boolean") {
    hash.update(value ? "true" : "false");
    return;
  }
  if (typeof value === "string") {
    updateCanonicalString(hash, value);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical values must contain finite numbers");
    }
    hash.update(Object.is(value, -0) ? "0" : JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    hash.update("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) hash.update(",");
      updateCanonicalHash(hash, value[index]);
    }
    hash.update("]");
    return;
  }
  if (isPlainRecord(value)) {
    hash.update("{");
    const keys = Object.keys(value).sort();
    for (let index = 0; index < keys.length; index += 1) {
      if (index > 0) hash.update(",");
      const key = keys[index];
      updateCanonicalString(hash, key);
      hash.update(":");
      updateCanonicalHash(hash, value[key]);
    }
    hash.update("}");
    return;
  }
  throw new TypeError("canonical values must be JSON-compatible");
};

const digest = (value) => {
  const hash = createHash("sha256");
  updateCanonicalHash(hash, value);
  return hash.digest("hex");
};

const quantizeNumber = (value) => {
  if (!Number.isFinite(value)) {
    throw new TypeError("computed values must remain finite");
  }
  if (value === 0) return 0;
  return Number(value.toPrecision(15));
};

const quantizeAlignment = (value) => (
  Math.max(-1, Math.min(1, quantizeNumber(value)))
);

const consumeJsonStringBytes = (value, consume) => {
  consume(2);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      consume(2);
    } else if (code <= 0x1f) {
      consume(
        code === 0x08
          || code === 0x09
          || code === 0x0a
          || code === 0x0c
          || code === 0x0d
          ? 2
          : 6,
      );
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        consume(4);
        index += 1;
      } else {
        consume(6);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      consume(6);
    } else if (code <= 0x7f) {
      consume(1);
    } else if (code <= 0x7ff) {
      consume(2);
    } else {
      consume(3);
    }
  }
};

const consumeCanonicalBytes = (value, consume) => {
  if (value === null) {
    consume(4);
    return;
  }
  if (typeof value === "boolean") {
    consume(value ? 4 : 5);
    return;
  }
  if (typeof value === "string") {
    consumeJsonStringBytes(value, consume);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical values must contain finite numbers");
    }
    consume(Buffer.byteLength(
      Object.is(value, -0) ? "0" : JSON.stringify(value),
      "utf8",
    ));
    return;
  }
  if (Array.isArray(value)) {
    consume(1);
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) consume(1);
      consumeCanonicalBytes(value[index], consume);
    }
    consume(1);
    return;
  }
  if (isPlainRecord(value)) {
    consume(1);
    const keys = Object.keys(value).sort();
    for (let index = 0; index < keys.length; index += 1) {
      if (index > 0) consume(1);
      const key = keys[index];
      consumeJsonStringBytes(key, consume);
      consume(1);
      consumeCanonicalBytes(value[key], consume);
    }
    consume(1);
    return;
  }
  throw new TypeError("canonical values must be JSON-compatible");
};

const enforceOutputByteLimit = (value, limits) => {
  let bytes = 0;
  const consume = (amount) => {
    if (amount > limits.maxOutputBytes - bytes) {
      throw new GapEngineLimitError(
        LIMIT_CODES.maxOutputBytes,
        "output",
        limits.maxOutputBytes,
        bytes + amount,
      );
    }
    bytes += amount;
  };
  consumeCanonicalBytes(value, consume);
};

const deepFreeze = (value) => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

const normalizeProperties = (
  properties,
  label,
  consumeBytes,
  consumeFields,
) => {
  if (properties === undefined) return undefined;
  if (!isPlainRecord(properties)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const ownKeys = Reflect.ownKeys(properties);
  consumeFields(ownKeys.length);
  const keys = [];
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} must not contain symbol keys`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(properties, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} must not contain accessors`);
    }
    if (!descriptor.enumerable) {
      throw new TypeError(`${label} must not contain non-enumerable fields`);
    }
    keys.push(key);
  }
  keys.sort();
  const normalized = {};
  consumeBytes(2);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (PROPERTY_FORBIDDEN_KEYS.has(key)) {
      throw new TypeError(`${label} contains a forbidden property key`);
    }
    const value = Object.getOwnPropertyDescriptor(properties, key).value;
    if (
      value !== null
      && typeof value !== "string"
      && typeof value !== "boolean"
      && !(typeof value === "number" && Number.isFinite(value))
    ) {
      throw new TypeError(`${label} values must be JSON scalar values`);
    }
    if (index > 0) consumeBytes(1);
    consumeJsonStringBytes(key, consumeBytes);
    consumeBytes(1);
    if (typeof value === "string") {
      consumeJsonStringBytes(value, consumeBytes);
    } else if (value === null) {
      consumeBytes(4);
    } else if (typeof value === "boolean") {
      consumeBytes(value ? 4 : 5);
    } else {
      consumeBytes(Buffer.byteLength(JSON.stringify(value), "utf8"));
    }
    normalized[key] = Object.is(value, -0) ? 0 : value;
  }
  return normalized;
};

const normalizePosition = (position, dimensions, label) => {
  let positionLength;
  try {
    positionLength = dataArrayLength(position, label);
  } catch {
    throw new TypeError(
      `${label} must be a ${dimensions}-dimensional numeric tuple`,
    );
  }
  if (positionLength !== dimensions) {
    throw new TypeError(
      `${label} must be a ${dimensions}-dimensional numeric tuple`,
    );
  }
  return copyDenseArray(position, label).map((value) => {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} must contain finite numbers`);
    }
    return Object.is(value, -0) ? 0 : value;
  });
};

const vectorBetween = (from, to) => {
  const vector = from.map((value, index) => to[index] - value);
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new TypeError("coordinate differences must remain finite");
  }
  return vector;
};

const vectorLength = (vector) => {
  const length = Math.hypot(...vector);
  if (!Number.isFinite(length)) {
    throw new TypeError("geometry length must remain finite");
  }
  return length;
};

const pointDistance = (from, to) => vectorLength(vectorBetween(from, to));

const dot = (left, right) => {
  let value = 0;
  for (let index = 0; index < left.length; index += 1) {
    value += left[index] * right[index];
  }
  if (!Number.isFinite(value)) {
    throw new TypeError("geometric calculations must remain finite");
  }
  return value;
};

const normalizeVector = (vector) => {
  const length = vectorLength(vector);
  if (length === 0) return null;
  return vector.map((value) => value / length);
};

const compareNumbers = (left, right) => (
  left < right ? -1 : left > right ? 1 : 0
);

const boundsForItems = (items, dimensions) => {
  const minimum = Array(dimensions).fill(Infinity);
  const maximum = Array(dimensions).fill(-Infinity);
  for (const item of items) {
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      minimum[dimension] = Math.min(
        minimum[dimension],
        item.minimum[dimension],
      );
      maximum[dimension] = Math.max(
        maximum[dimension],
        item.maximum[dimension],
      );
    }
  }
  return { minimum, maximum };
};

const buildSpatialTree = (items, dimensions) => {
  if (items.length === 0) return null;
  const build = (subset) => {
    const bounds = boundsForItems(subset, dimensions);
    if (subset.length <= 8) {
      return {
        ...bounds,
        items: subset.slice().sort(compareSpatialItems),
      };
    }
    let axis = 0;
    let widest = -1;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const span = bounds.maximum[dimension] - bounds.minimum[dimension];
      if (span > widest) {
        axis = dimension;
        widest = span;
      }
    }
    const ordered = subset.slice().sort((left, right) => (
      compareNumbers(left.minimum[axis], right.minimum[axis])
      || compareNumbers(left.maximum[axis], right.maximum[axis])
      || compareSpatialItems(left, right)
    ));
    const middle = Math.floor(ordered.length / 2);
    return {
      ...bounds,
      left: build(ordered.slice(0, middle)),
      right: build(ordered.slice(middle)),
    };
  };
  return build(items);
};

const pointToBoundsDistance = (point, minimum, maximum) => (
  Math.hypot(...point.map((value, dimension) => (
    value < minimum[dimension]
      ? minimum[dimension] - value
      : value > maximum[dimension]
        ? value - maximum[dimension]
        : 0
  )))
);

const querySpatialTree = (tree, point, radius, visit) => {
  if (
    !tree
    || pointToBoundsDistance(point, tree.minimum, tree.maximum) > radius
  ) {
    return;
  }
  if (tree.items) {
    for (const item of tree.items) visit(item);
    return;
  }
  querySpatialTree(tree.left, point, radius, visit);
  querySpatialTree(tree.right, point, radius, visit);
};

const expandedSearchRadius = (radius) => {
  if (radius === 0 || radius === Number.MAX_VALUE) return radius;
  const expanded = radius + Math.max(Number.MIN_VALUE, radius * 1e-14);
  return Number.isFinite(expanded) ? expanded : Number.MAX_VALUE;
};

const compareStrings = (left, right) => (
  left < right ? -1 : left > right ? 1 : 0
);

const compareSpatialItems = (left, right) => (
  compareNumbers(left.sortOrdinal, right.sortOrdinal)
  || compareNumbers(left.sortIndex ?? 0, right.sortIndex ?? 0)
);

const addOrderedPair = (pairs, left, right) => {
  if (!pairs.has(left)) pairs.set(left, new Set());
  pairs.get(left).add(right);
};

const addUndirectedPair = (pairs, left, right) => {
  addOrderedPair(pairs, left, right);
  addOrderedPair(pairs, right, left);
};

const hasOrderedPair = (pairs, left, right) => (
  pairs.get(left)?.has(right) ?? false
);

const orderedPairMap = (pairs) => {
  const output = new Map();
  for (const [left, right] of pairs) addOrderedPair(output, left, right);
  return output;
};

const undirectedPairMap = (pairs) => {
  const output = new Map();
  for (const [left, right] of pairs) addUndirectedPair(output, left, right);
  return output;
};

class UnionFind {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }

  find(id) {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let current = id;
    while (current !== root) {
      const next = this.parent.get(current);
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort(compareStrings);
    this.parent.set(second, first);
  }
}

const normalizeLimits = (input = {}) => {
  input = assertRecord(input, "limits");
  assertKnownKeys(input, LIMIT_KEYS, "limit");
  const limits = { ...DEFAULT_LIMITS };
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    limits[name] = safeNonNegativeInteger(value, name);
  }
  return limits;
};

const normalizeProposal = (input = {}) => {
  input = assertRecord(input, "proposal");
  assertKnownKeys(input, PROPOSAL_KEYS, "proposal");
  const proposal = { ...DEFAULT_PROPOSAL };
  for (const [name, value] of Object.entries(input)) {
    if (value !== undefined) proposal[name] = value;
  }
  finiteNonNegative(proposal.maxGapDistance, "maxGapDistance");
  safeNonNegativeInteger(
    proposal.maxCandidatesPerEndpoint,
    "maxCandidatesPerEndpoint",
  );
  for (const name of [
    "includeEndpointToEdge",
    "requireDifferentComponents",
    "requireTangentEvidence",
  ]) {
    if (typeof proposal[name] !== "boolean") {
      throw new TypeError(`${name} must be a boolean`);
    }
  }
  return proposal;
};

const normalizePairList = (
  value,
  label,
  leftTokens,
  rightTokens,
  countString,
) => {
  if (value === undefined) return [];
  try {
    dataArrayLength(value, label);
  } catch {
    throw new TypeError(`${label} must be an array of id pairs`);
  }
  const unordered = leftTokens === rightTokens;
  const pairs = copyDenseArray(value, label).map((pair) => {
    let normalizedPair;
    try {
      if (dataArrayLength(pair, `${label} pair`) !== 2) {
        throw new TypeError();
      }
      normalizedPair = copyDenseArray(pair, `${label} pair`);
    } catch {
      throw new TypeError(`${label} must be an array of id pairs`);
    }
    if (
      typeof normalizedPair[0] !== "string"
      || typeof normalizedPair[1] !== "string"
      || !leftTokens.has(normalizedPair[0])
      || !rightTokens.has(normalizedPair[1])
    ) {
      throw new TypeError(`${label} must reference known string ids`);
    }
    countString(normalizedPair[0]);
    countString(normalizedPair[1]);
    const left = leftTokens.get(normalizedPair[0]);
    const right = rightTokens.get(normalizedPair[1]);
    return unordered && right < left
      ? [right, left]
      : [left, right];
  });
  pairs.sort((left, right) => (
    compareNumbers(left[0], right[0])
    || compareNumbers(left[1], right[1])
  ));
  return pairs.filter((pair, index) => (
    index === 0
    || pair[0] !== pairs[index - 1][0]
    || pair[1] !== pairs[index - 1][1]
  ));
};

const normalizeSnapshot = (snapshot, limits) => {
  snapshot = assertRecord(snapshot, "snapshot");
  assertKnownKeys(snapshot, SNAPSHOT_KEYS, "snapshot");
  if (snapshot.schema !== NETWORK_SCHEMA) {
    throw new TypeError(`snapshot schema must be ${NETWORK_SCHEMA}`);
  }
  let stringBytes = 0;
  const countString = (value) => {
    if (value.length > limits.maxStringBytes - stringBytes) {
      throw new GapEngineLimitError(
        LIMIT_CODES.maxStringBytes,
        "input",
        limits.maxStringBytes,
        stringBytes + value.length,
      );
    }
    stringBytes += Buffer.byteLength(value, "utf8");
    enforceLimit(limits, "maxStringBytes", "input", stringBytes);
    return value;
  };
  const networkId = countString(
    nonEmptyString(snapshot.networkId, "networkId"),
  );
  const revision = countString(
    nonEmptyString(snapshot.revision, "revision"),
  );
  const rawSpace = assertRecord(snapshot.space, "space");
  assertKnownKeys(rawSpace, SPACE_KEYS, "space");
  const dimensions = rawSpace.dimensions;
  if (dimensions !== 2 && dimensions !== 3) {
    throw new TypeError("space dimensions must be 2 or 3");
  }
  const space = {
    dimensions,
    unit: countString(nonEmptyString(rawSpace.unit, "space unit")),
    frame: countString(nonEmptyString(rawSpace.frame, "space frame")),
    metric: rawSpace.metric ?? "euclidean",
  };
  if (space.metric !== "euclidean") {
    throw new TypeError("space metric must be euclidean");
  }
  const nodeCount = dataArrayLength(snapshot.nodes, "snapshot nodes");
  const edgeCount = dataArrayLength(snapshot.edges, "snapshot edges");
  enforceLimit(limits, "maxNodes", "input", nodeCount);
  enforceLimit(limits, "maxEdges", "input", edgeCount);
  const rawNodes = copyDenseArray(snapshot.nodes, "snapshot nodes");
  const rawEdges = copyDenseArray(snapshot.edges, "snapshot edges");

  const nodeIds = new Set();
  let propertyBytes = 0;
  let propertyFields = 0;
  const consumePropertyBytes = (bytes) => {
    propertyBytes += bytes;
    enforceLimit(
      limits,
      "maxPropertyBytes",
      "input",
      propertyBytes,
    );
  };
  const consumePropertyFields = (fields) => {
    propertyFields += fields;
    enforceLimit(
      limits,
      "maxPropertyFields",
      "input",
      propertyFields,
    );
  };
  const nodes = rawNodes.map((node, index) => {
    node = assertRecord(node, `node ${index}`);
    assertKnownKeys(node, NODE_KEYS, "node");
    const id = countString(nonEmptyString(node.id, `node ${index} id`));
    if (nodeIds.has(id)) throw new TypeError("node ids must be unique");
    nodeIds.add(id);
    const normalized = {
      id,
      position: normalizePosition(
        node.position,
        dimensions,
        `node ${index} position`,
      ),
    };
    const properties = normalizeProperties(
      node.properties,
      `node ${index} properties`,
      consumePropertyBytes,
      consumePropertyFields,
    );
    if (properties !== undefined) normalized.properties = properties;
    return normalized;
  }).sort((left, right) => compareStrings(left.id, right.id));

  const edgeIds = new Set();
  let totalPoints = 0;
  const edges = rawEdges.map((edge, index) => {
    edge = assertRecord(edge, `edge ${index}`);
    assertKnownKeys(edge, EDGE_KEYS, "edge");
    const id = countString(nonEmptyString(edge.id, `edge ${index} id`));
    if (edgeIds.has(id)) throw new TypeError("edge ids must be unique");
    edgeIds.add(id);
    const from = countString(nonEmptyString(edge.from, `edge ${index} from`));
    const to = countString(nonEmptyString(edge.to, `edge ${index} to`));
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      throw new TypeError("edges must reference known node ids");
    }
    const geometryPointCount = dataArrayLength(
      edge.geometry,
      `edge ${index} geometry`,
    );
    if (geometryPointCount < 2) {
      throw new TypeError("edge geometry must contain at least two points");
    }
    const nextTotalPoints = totalPoints + geometryPointCount;
    enforceLimit(limits, "maxTotalPoints", "input", nextTotalPoints);
    const rawGeometry = copyDenseArray(
      edge.geometry,
      `edge ${index} geometry`,
    );
    totalPoints = nextTotalPoints;
    const geometry = rawGeometry.map((position, pointIndex) => (
      normalizePosition(
        position,
        dimensions,
        `edge ${index} point ${pointIndex}`,
      )
    ));
    let measuredLength = 0;
    for (let pointIndex = 1; pointIndex < geometry.length; pointIndex += 1) {
      measuredLength += pointDistance(
        geometry[pointIndex - 1],
        geometry[pointIndex],
      );
      if (!Number.isFinite(measuredLength)) {
        throw new TypeError("edge geometry length must remain finite");
      }
    }
    if (measuredLength === 0) {
      throw new TypeError("edge geometry must have positive length");
    }
    const direction = edge.direction ?? "both";
    if (!["both", "forward", "reverse"].includes(direction)) {
      throw new TypeError(
        "edge direction must be both, forward, or reverse",
      );
    }
    const normalized = {
      id,
      from,
      to,
      geometry,
      direction,
    };
    const properties = normalizeProperties(
      edge.properties,
      `edge ${index} properties`,
      consumePropertyBytes,
      consumePropertyFields,
    );
    if (properties !== undefined) normalized.properties = properties;
    return normalized;
  }).sort((left, right) => compareStrings(left.id, right.id));

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    const fromPosition = nodeById.get(edge.from).position;
    const toPosition = nodeById.get(edge.to).position;
    if (
      pointDistance(edge.geometry[0], fromPosition) !== 0
      || pointDistance(edge.geometry.at(-1), toPosition) !== 0
    ) {
      throw new TypeError(
        "edge geometry endpoints must exactly match their nodes",
      );
    }
  }

  return {
    snapshot: {
      schema: NETWORK_SCHEMA,
      networkId,
      revision,
      space,
      nodes,
      edges,
    },
    stringBytes,
  };
};

const buildTopology = (snapshot) => {
  const incidents = new Map(snapshot.nodes.map((node) => [node.id, []]));
  const components = new UnionFind(snapshot.nodes.map((node) => node.id));
  const directNodePairs = new Map();
  for (const edge of snapshot.edges) {
    incidents.get(edge.from).push(edge);
    incidents.get(edge.to).push(edge);
    components.union(edge.from, edge.to);
    addUndirectedPair(directNodePairs, edge.from, edge.to);
  }
  for (const edges of incidents.values()) {
    edges.sort((left, right) => compareStrings(left.id, right.id));
  }
  return { components, directNodePairs, incidents };
};

const endpointTangent = (node, incidents) => {
  const edges = incidents.get(node.id);
  if (edges.length !== 1) return null;
  const edge = edges[0];
  const geometry = edge.geometry;
  const atStart = edge.from === node.id;
  const endpointIndex = atStart ? 0 : geometry.length - 1;
  const step = atStart ? 1 : -1;
  for (
    let index = endpointIndex + step;
    index >= 0 && index < geometry.length;
    index += step
  ) {
    const inward = vectorBetween(node.position, geometry[index]);
    const normalized = normalizeVector(inward);
    if (normalized) return normalized.map((value) => -value);
  }
  return null;
};

const buildEdgeSegmentItems = (snapshot, edgeTokens) => {
  const items = [];
  for (const edge of snapshot.edges) {
    const edgeItems = [];
    let cumulative = 0;
    for (let index = 0; index < edge.geometry.length - 1; index += 1) {
      const start = edge.geometry[index];
      const end = edge.geometry[index + 1];
      const segment = vectorBetween(start, end);
      const segmentLength = vectorLength(segment);
      if (segmentLength === 0) continue;
      const record = {
        edge,
        edgeSegmentIndex: index,
        edgeTangent: segment.map((value) => value / segmentLength),
        end,
        segment,
        segmentLength,
        segmentStartDistance: cumulative,
        start,
      };
      const item = {
        minimum: start.map(
          (value, dimension) => Math.min(value, end[dimension]),
        ),
        maximum: start.map(
          (value, dimension) => Math.max(value, end[dimension]),
        ),
        sortOrdinal: edgeTokens.get(edge.id),
        sortIndex: index,
        value: record,
      };
      edgeItems.push(item);
      items.push(item);
      cumulative += segmentLength;
    }
    for (let index = 0; index < edgeItems.length; index += 1) {
      const record = edgeItems[index].value;
      record.edgeLength = cumulative;
      record.firstNonzeroSegment = index === 0;
      record.lastNonzeroSegment = index === edgeItems.length - 1;
    }
  }
  return items;
};

const rawSegmentProjection = (point, record) => {
  const projection = robustProjection(
    point,
    record.start,
    record.end,
    record.segment,
  );
  const position = projection.position.map(
    (coordinate) => Object.is(coordinate, -0) ? 0 : coordinate,
  );
  if (!Number.isFinite(projection.distance)) {
    throw new TypeError("projected distance must remain finite");
  }
  return {
    ...record,
    rawDistance: projection.distance,
    rawDistanceAlong: projection.distanceAlong,
    rawFraction: projection.fraction,
    rawPosition: position,
  };
};

const finalizeSegmentProjection = (best) => {
  const segmentFraction = best.rawFraction;
  const position = best.rawPosition.slice();
  const distance = Object.is(best.rawDistance, -0) ? 0 : best.rawDistance;
  const distanceAlong = (
    best.segmentStartDistance
      + best.rawDistanceAlong
  );
  if (!Number.isFinite(distanceAlong)) {
    throw new TypeError("projection distance along edge must remain finite");
  }
  return {
    edgeSegmentIndex: best.edgeSegmentIndex,
    segmentFraction,
    position,
    distance,
    distanceAlong,
    edgeTangent: best.edgeTangent,
    atEndpoint: (
      (best.firstNonzeroSegment && segmentFraction === 0)
      || (best.lastNonzeroSegment && segmentFraction === 1)
    ),
    edgeLength: best.edgeLength,
  };
};

const normalizedDirection = (from, to) => (
  normalizeVector(vectorBetween(from, to))
);

const assessCandidate = (
  operation,
  features,
  proposal,
  components,
  forbiddenNodePairs,
  forbiddenNodeEdgePairs,
  nodeTokens,
  edgeTokens,
) => {
  const constraintResults = [];
  const reasonCodes = [];
  const sourceComponent = components.find(operation.fromNodeId);
  const targetComponent = operation.kind === "connect-nodes"
    ? components.find(operation.toNodeId)
    : components.find(operation.edgeFromNodeId);
  const differentComponents = sourceComponent !== targetComponent;
  constraintResults.push({
    id: "different-components",
    result: (
      !proposal.requireDifferentComponents || differentComponents
    ) ? "pass" : "fail",
  });
  if (proposal.requireDifferentComponents && !differentComponents) {
    reasonCodes.push("SAME_COMPONENT");
  }

  const forbidden = operation.kind === "connect-nodes"
    ? hasOrderedPair(
      forbiddenNodePairs,
      nodeTokens.get(operation.fromNodeId),
      nodeTokens.get(operation.toNodeId),
    )
    : hasOrderedPair(
      forbiddenNodeEdgePairs,
      nodeTokens.get(operation.fromNodeId),
      edgeTokens.get(operation.toEdgeId),
    );
  constraintResults.push({
    id: "forbidden-connection",
    result: forbidden ? "fail" : "pass",
  });
  if (forbidden) reasonCodes.push("FORBIDDEN_CONNECTION");

  if (reasonCodes.length > 0) {
    return {
      status: "reject",
      reasonCodes,
      constraintResults,
    };
  }

  const tangentAvailable = operation.kind === "connect-nodes"
    ? features.sourceTangentAlignment !== null
      && features.targetTangentAlignment !== null
    : features.sourceTangentAlignment !== null;
  constraintResults.push({
    id: "tangent-evidence",
    result: tangentAvailable ? "pass" : "unknown",
  });
  if (proposal.requireTangentEvidence && !tangentAvailable) {
    return {
      status: "abstain",
      reasonCodes: ["TANGENT_EVIDENCE_UNAVAILABLE"],
      constraintResults,
    };
  }
  return {
    status: "review",
    reasonCodes: ["HUMAN_REVIEW_REQUIRED"],
    constraintResults,
  };
};

const candidateSort = (left, right, nodeTokens, edgeTokens) => (
  STATUS_ORDER[left.assessment.status] - STATUS_ORDER[right.assessment.status]
  || left.features.distance - right.features.distance
  || compareStrings(left.operation.kind, right.operation.kind)
  || compareNumbers(
    nodeTokens.get(left.operation.fromNodeId),
    nodeTokens.get(right.operation.fromNodeId),
  )
  || compareNumbers(
    left.operation.kind === "connect-nodes"
      ? nodeTokens.get(left.operation.toNodeId)
      : edgeTokens.get(left.operation.toEdgeId),
    right.operation.kind === "connect-nodes"
      ? nodeTokens.get(right.operation.toNodeId)
      : edgeTokens.get(right.operation.toEdgeId),
  )
);

const candidateIdentity = (operation, nodeTokens, edgeTokens) => (
  operation.kind === "connect-nodes"
    ? {
      kind: operation.kind,
      fromNode: nodeTokens.get(operation.fromNodeId),
      toNode: nodeTokens.get(operation.toNodeId),
      direction: operation.direction,
    }
    : {
      kind: operation.kind,
      fromNode: nodeTokens.get(operation.fromNodeId),
      toEdge: edgeTokens.get(operation.toEdgeId),
      edgeSegmentIndex: operation.edgeSegmentIndex,
      segmentFraction: operation.segmentFraction,
      distanceAlong: operation.distanceAlong,
    }
);

const normalizeInput = (input) => {
  input = assertRecord(input, "engine input");
  assertKnownKeys(input, INPUT_KEYS, "engine input");
  const limits = normalizeLimits(input.limits);
  const proposal = normalizeProposal(input.proposal);
  const normalizedSnapshot = normalizeSnapshot(input.snapshot, limits);
  const { snapshot } = normalizedSnapshot;
  const nodeTokens = new Map(snapshot.nodes.map(
    (node, index) => [node.id, index],
  ));
  const edgeTokens = new Map(snapshot.edges.map(
    (edge, index) => [edge.id, index],
  ));
  let stringBytes = normalizedSnapshot.stringBytes;
  const stringByteLengths = new Map();
  const countConstraintString = (value) => {
    let byteLength = stringByteLengths.get(value);
    if (byteLength === undefined) {
      byteLength = Buffer.byteLength(value, "utf8");
      stringByteLengths.set(value, byteLength);
    }
    if (byteLength > limits.maxStringBytes - stringBytes) {
      throw new GapEngineLimitError(
        LIMIT_CODES.maxStringBytes,
        "input",
        limits.maxStringBytes,
        stringBytes + byteLength,
      );
    }
    stringBytes += byteLength;
  };
  const rawConstraints = input.constraints ?? {};
  const safeConstraints = assertRecord(rawConstraints, "constraints");
  assertKnownKeys(safeConstraints, CONSTRAINT_KEYS, "constraint");
  const constraintArrayLength = (value, label) => {
    try {
      return dataArrayLength(value, label);
    } catch {
      throw new TypeError(`${label} must be an array of id pairs`);
    }
  };
  const nodePairCount = safeConstraints.forbiddenNodePairs === undefined
    ? 0
    : constraintArrayLength(
      safeConstraints.forbiddenNodePairs,
      "forbiddenNodePairs",
    );
  const nodeEdgePairCount =
    safeConstraints.forbiddenNodeEdgePairs === undefined
      ? 0
      : constraintArrayLength(
        safeConstraints.forbiddenNodeEdgePairs,
        "forbiddenNodeEdgePairs",
      );
  const constraintPairCount = nodePairCount + nodeEdgePairCount;
  enforceLimit(
    limits,
    "maxConstraintPairs",
    "input",
    constraintPairCount,
  );
  const constraints = {
    forbiddenNodePairs: normalizePairList(
      safeConstraints.forbiddenNodePairs,
      "forbiddenNodePairs",
      nodeTokens,
      nodeTokens,
      countConstraintString,
    ),
    forbiddenNodeEdgePairs: normalizePairList(
      safeConstraints.forbiddenNodeEdgePairs,
      "forbiddenNodeEdgePairs",
      nodeTokens,
      edgeTokens,
      countConstraintString,
    ),
  };
  return deepFreeze({
    snapshot,
    proposal,
    constraints,
    limits,
    nodeTokens,
    edgeTokens,
  });
};

export class GapAnalysisEngine {
  #analysis;
  #input;

  constructor(input) {
    this.#input = normalizeInput(input);
    this.#analysis = null;
  }

  analyze() {
    if (this.#analysis) return this.#analysis;
    const {
      snapshot,
      proposal,
      constraints,
      limits,
      nodeTokens,
      edgeTokens,
    } = this.#input;
    const networkDigest = digest(snapshot);
    const configurationDigest = digest({
      networkDigest,
      proposal,
      constraints,
    });
    const executionProfileDigest = digest({ limits });
    const {
      components,
      directNodePairs,
      incidents,
    } = buildTopology(snapshot);
    const endpoints = snapshot.nodes
      .filter((node) => incidents.get(node.id).length <= 1);
    const tangents = new Map(endpoints.map((node) => [
      node.id,
      endpointTangent(node, incidents),
    ]));
    const dimensions = snapshot.space.dimensions;
    const nodeTree = buildSpatialTree(
      snapshot.nodes.map((node) => ({
        minimum: node.position,
        maximum: node.position,
        sortOrdinal: nodeTokens.get(node.id),
        value: node,
      })),
      dimensions,
    );
    const segmentItems = proposal.includeEndpointToEdge
      ? buildEdgeSegmentItems(snapshot, edgeTokens)
      : [];
    const segmentTree = buildSpatialTree(segmentItems, dimensions);
    const searchRadius = expandedSearchRadius(proposal.maxGapDistance);
    const forbiddenNodePairs = undirectedPairMap(
      constraints.forbiddenNodePairs,
    );
    const forbiddenNodeEdgePairs = orderedPairMap(
      constraints.forbiddenNodeEdgePairs,
    );
    let neighborChecks = 0;
    let candidatesCreated = 0;
    const generatedCandidates = [];

    const countNeighborCheck = () => {
      neighborChecks += 1;
      enforceLimit(
        limits,
        "maxNeighborChecks",
        "candidate-generation",
        neighborChecks,
      );
    };
    const finalizeCandidate = (operation, geometry, features) => {
      const assessment = assessCandidate(
        operation,
        features,
        proposal,
        components,
        forbiddenNodePairs,
        forbiddenNodeEdgePairs,
        nodeTokens,
        edgeTokens,
      );
      const unsigned = {
        operation,
        geometry,
        features,
        assessment,
      };
      candidatesCreated += 1;
      enforceLimit(
        limits,
        "maxCandidatesTotal",
        "candidate-generation",
        candidatesCreated,
      );
      const id = digest({
        networkDigest,
        algorithm: ALGORITHM,
        operation: candidateIdentity(operation, nodeTokens, edgeTokens),
      });
      generatedCandidates.push({ id, ...unsigned });
    };

    const endpointIds = new Set(endpoints.map((node) => node.id));
    for (const left of endpoints) {
      const nearbyNodes = [];
      querySpatialTree(
        nodeTree,
        left.position,
        searchRadius,
        (item) => {
          countNeighborCheck();
          if (
            pointToBoundsDistance(
              left.position,
              item.minimum,
              item.maximum,
            ) <= searchRadius
          ) {
            nearbyNodes.push(item.value);
          }
        },
      );
      nearbyNodes.sort((first, second) => compareStrings(first.id, second.id));
      for (const right of nearbyNodes) {
        if (left.id === right.id) continue;
        if (
          endpointIds.has(right.id)
          && compareStrings(left.id, right.id) >= 0
        ) {
          continue;
        }
        countNeighborCheck();
        if (hasOrderedPair(directNodePairs, left.id, right.id)) continue;
        const rawDistance = pointDistance(left.position, right.position);
        if (rawDistance > proposal.maxGapDistance) continue;
        const distance = Object.is(rawDistance, -0) ? 0 : rawDistance;
        const towardRight = normalizedDirection(left.position, right.position);
        const towardLeft = towardRight?.map((value) => -value) ?? null;
        const leftTangent = tangents.get(left.id);
        const rightTangent = tangents.get(right.id);
        const operation = {
          kind: "connect-nodes",
          fromNodeId: left.id,
          toNodeId: right.id,
          direction: "unspecified",
        };
        const features = {
          distance,
          sourceTangentAlignment: leftTangent && towardRight
            ? quantizeAlignment(dot(leftTangent, towardRight))
            : null,
          targetTangentAlignment: rightTangent && towardLeft
            ? quantizeAlignment(dot(rightTangent, towardLeft))
            : null,
          targetEdgeTangentAlignment: null,
        };
        finalizeCandidate(
          operation,
          [left.position.slice(), right.position.slice()],
          features,
        );
      }
    }

    if (proposal.includeEndpointToEdge) {
      for (const endpoint of endpoints) {
        const nearbySegments = [];
        querySpatialTree(
          segmentTree,
          endpoint.position,
          searchRadius,
          (item) => {
            countNeighborCheck();
            if (
              pointToBoundsDistance(
                endpoint.position,
                item.minimum,
                item.maximum,
              ) <= searchRadius
            ) {
              nearbySegments.push(item);
            }
          },
        );
        nearbySegments.sort(
          compareSpatialItems,
        );
        const bestByEdge = new Map();
        for (const item of nearbySegments) {
          const record = item.value;
          const { edge } = record;
          if (edge.from === endpoint.id || edge.to === endpoint.id) continue;
          const projected = rawSegmentProjection(endpoint.position, record);
          const best = bestByEdge.get(edge.id);
          if (
            !best
            || projected.rawDistance < best.rawDistance
            || (
              projected.rawDistance === best.rawDistance
              && projected.edgeSegmentIndex < best.edgeSegmentIndex
            )
          ) {
            bestByEdge.set(edge.id, projected);
          }
        }
        const edgeProjections = [...bestByEdge.values()].sort(
          (left, right) => compareNumbers(
            edgeTokens.get(left.edge.id),
            edgeTokens.get(right.edge.id),
          ),
        );
        for (const rawProjection of edgeProjections) {
          if (
            rawProjection.rawDistance > proposal.maxGapDistance
          ) {
            continue;
          }
          const edge = rawProjection.edge;
          const projection = finalizeSegmentProjection(rawProjection);
          if (projection.atEndpoint) {
            continue;
          }
          const towardEdge = normalizedDirection(
            endpoint.position,
            projection.position,
          );
          const sourceTangent = tangents.get(endpoint.id);
          const operation = {
            kind: "attach-node-to-edge",
            fromNodeId: endpoint.id,
            toEdgeId: edge.id,
            edgeFromNodeId: edge.from,
            edgeToNodeId: edge.to,
            edgeSegmentIndex: projection.edgeSegmentIndex,
            segmentFraction: projection.segmentFraction,
            distanceAlong: projection.distanceAlong,
          };
          const features = {
            distance: projection.distance,
            sourceTangentAlignment: sourceTangent && towardEdge
              ? quantizeAlignment(dot(sourceTangent, towardEdge))
              : null,
            targetTangentAlignment: null,
            targetEdgeTangentAlignment: towardEdge
              ? quantizeAlignment(
                Math.abs(dot(projection.edgeTangent, towardEdge)),
              )
              : null,
          };
          finalizeCandidate(
            operation,
            [
              endpoint.position.slice(),
              projection.position.slice(),
            ],
            features,
          );
        }
      }
    }

    generatedCandidates.sort(
      (left, right) => candidateSort(
        left,
        right,
        nodeTokens,
        edgeTokens,
      ),
    );
    const endpointCandidateCounts = new Map(
      endpoints.map((node) => [node.id, 0]),
    );
    const selectedCandidateIds = new Set();
    for (const candidate of generatedCandidates) {
      const endpointIds = candidate.operation.kind === "connect-nodes"
        ? [
          candidate.operation.fromNodeId,
          candidate.operation.toNodeId,
        ].filter((id) => endpointCandidateCounts.has(id))
        : [candidate.operation.fromNodeId];
      for (const id of endpointIds) {
        if (
          endpointCandidateCounts.get(id)
          >= proposal.maxCandidatesPerEndpoint
        ) {
          continue;
        }
        selectedCandidateIds.add(candidate.id);
        endpointCandidateCounts.set(
          id,
          endpointCandidateCounts.get(id) + 1,
        );
      }
    }
    const candidates = generatedCandidates.filter(
      (candidate) => selectedCandidateIds.has(candidate.id),
    );
    const statusCounts = {
      review: 0,
      reject: 0,
      abstain: 0,
    };
    for (const candidate of candidates) {
      statusCounts[candidate.assessment.status] += 1;
    }
    const analysisCore = {
      schema: ANALYSIS_SCHEMA,
      algorithm: ALGORITHM,
      network: {
        networkId: snapshot.networkId,
        revision: snapshot.revision,
        digest: networkDigest,
        dimensions: snapshot.space.dimensions,
        unit: snapshot.space.unit,
        frame: snapshot.space.frame,
      },
      configurationDigest,
      executionProfileDigest,
      executionComplete: true,
      candidates,
      selection: {
        policy: "per-endpoint-union",
        truncated: candidates.length < candidatesCreated,
        omitted: candidatesCreated - candidates.length,
        maxCandidatesPerEndpoint: proposal.maxCandidatesPerEndpoint,
      },
      summary: {
        nodes: snapshot.nodes.length,
        edges: snapshot.edges.length,
        endpoints: endpoints.length,
        neighborChecks,
        candidatesConsidered: candidatesCreated,
        candidatesReturned: candidates.length,
        statusCounts,
      },
      warnings: [
        "Geometry-only assessments are not calibrated probabilities.",
        "Review status does not authorize graph mutation or routing.",
      ],
    };
    enforceOutputByteLimit({
      ...analysisCore,
      digest: "0".repeat(64),
    }, limits);
    const analysisDigestPayload = {
      ...analysisCore,
      candidates: candidates.map((candidate) => digest({
        id: candidate.id,
        geometry: candidate.geometry,
        features: candidate.features,
        assessment: candidate.assessment,
      })),
    };
    this.#analysis = deepFreeze({
      ...analysisCore,
      digest: digest(analysisDigestPayload),
    });
    return this.#analysis;
  }
}

export const createGapEngine = (input) => new GapAnalysisEngine(input);
export const analyzeGaps = (input) => createGapEngine(input).analyze();
