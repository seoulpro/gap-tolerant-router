const FLOAT_BITS = new DataView(new ArrayBuffer(8));
const FRACTION_MASK = (1n << 52n) - 1n;
const IMPLICIT_BIT = 1n << 52n;

const dyadicFromNumber = (value) => {
  FLOAT_BITS.setFloat64(0, value, false);
  const bits = FLOAT_BITS.getBigUint64(0, false);
  const negative = (bits >> 63n) === 1n;
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & FRACTION_MASK;
  if (exponentBits === 0 && fraction === 0n) {
    return { coefficient: 0n, exponent: 0 };
  }
  const coefficient = exponentBits === 0
    ? fraction
    : IMPLICIT_BIT + fraction;
  return {
    coefficient: negative ? -coefficient : coefficient,
    exponent: exponentBits === 0
      ? -1074
      : exponentBits - 1023 - 52,
  };
};

const addDyadic = (left, right) => {
  if (left.coefficient === 0n) return right;
  if (right.coefficient === 0n) return left;
  const exponent = Math.min(left.exponent, right.exponent);
  return {
    coefficient: (
      (left.coefficient << BigInt(left.exponent - exponent))
      + (right.coefficient << BigInt(right.exponent - exponent))
    ),
    exponent,
  };
};

const subtractDyadic = (left, right) => addDyadic(left, {
  coefficient: -right.coefficient,
  exponent: right.exponent,
});

const multiplyDyadic = (left, right) => ({
  coefficient: left.coefficient * right.coefficient,
  exponent: left.exponent + right.exponent,
});

const compareDyadic = (left, right) => {
  const exponent = Math.min(left.exponent, right.exponent);
  const leftCoefficient = (
    left.coefficient << BigInt(left.exponent - exponent)
  );
  const rightCoefficient = (
    right.coefficient << BigInt(right.exponent - exponent)
  );
  return leftCoefficient < rightCoefficient
    ? -1
    : leftCoefficient > rightCoefficient
      ? 1
      : 0;
};

const bitLength = (value) => value.toString(2).length;

const integerSquareRoot = (value) => {
  if (value < 2n) return value;
  let root = 1n << BigInt(Math.ceil(bitLength(value) / 2));
  for (;;) {
    const next = (root + value / root) >> 1n;
    if (next >= root) return root;
    root = next;
  }
};

const roundedRationalSquareRootInteger = (
  numerator,
  denominator,
  binaryExponent,
) => {
  let scaledNumerator = numerator;
  let scaledDenominator = denominator;
  if (binaryExponent >= 0) {
    scaledNumerator <<= BigInt(binaryExponent);
  } else {
    scaledDenominator <<= BigInt(-binaryExponent);
  }
  let root = integerSquareRoot(
    scaledNumerator / scaledDenominator,
  );
  const fourRootSquared = 4n * root * root;
  const midpointSquared = fourRootSquared + 4n * root + 1n;
  const left = scaledNumerator << 2n;
  const right = scaledDenominator * midpointSquared;
  if (
    left > right
    || (left === right && (root & 1n) === 1n)
  ) {
    root += 1n;
  }
  return root;
};

const floorLog2PositiveDyadicRatio = (numerator, denominator) => {
  const binaryOffset = numerator.exponent - denominator.exponent;
  let exponent = (
    bitLength(numerator.coefficient)
    - bitLength(denominator.coefficient)
    + binaryOffset
  );
  const left = {
    coefficient: numerator.coefficient,
    exponent: numerator.exponent,
  };
  const right = {
    coefficient: denominator.coefficient,
    exponent: denominator.exponent + exponent,
  };
  if (compareDyadic(left, right) < 0) exponent -= 1;
  return exponent;
};

const positiveDyadicRatioSquareRoot = (numerator, denominator) => {
  const ratioExponent = floorLog2PositiveDyadicRatio(
    numerator,
    denominator,
  );
  let resultExponent = Math.floor(ratioExponent / 2);
  const dyadicExponent = numerator.exponent - denominator.exponent;
  if (resultExponent >= -1022) {
    let significand = roundedRationalSquareRootInteger(
      numerator.coefficient,
      denominator.coefficient,
      dyadicExponent + 2 * (52 - resultExponent),
    );
    if (significand === (1n << 53n)) {
      significand >>= 1n;
      resultExponent += 1;
    }
    return Number(significand) * (2 ** (resultExponent - 52));
  }
  const significand = roundedRationalSquareRootInteger(
    numerator.coefficient,
    denominator.coefficient,
    dyadicExponent + 2148,
  );
  if (significand === 0n) return Number.MIN_VALUE;
  return Number(significand) * Number.MIN_VALUE;
};

const roundedQuotient = (numerator, denominator) => {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twiceRemainder = remainder << 1n;
  return (
    twiceRemainder > denominator
    || (
      twiceRemainder === denominator
      && (quotient & 1n) === 1n
    )
  ) ? quotient + 1n : quotient;
};

const dyadicRatioToNumber = (numerator, denominator) => {
  if (numerator.coefficient === 0n) return 0;
  const negative = numerator.coefficient < 0n;
  let scaledNumerator = negative
    ? -numerator.coefficient
    : numerator.coefficient;
  let scaledDenominator = denominator.coefficient;
  const dyadicExponent = numerator.exponent - denominator.exponent;
  if (dyadicExponent >= 0) {
    scaledNumerator <<= BigInt(dyadicExponent);
  } else {
    scaledDenominator <<= BigInt(-dyadicExponent);
  }

  const numeratorBits = bitLength(scaledNumerator);
  const denominatorBits = bitLength(scaledDenominator);
  let binaryExponent = numeratorBits - denominatorBits;
  const belowCandidatePower = binaryExponent >= 0
    ? scaledNumerator < (scaledDenominator << BigInt(binaryExponent))
    : (
      scaledNumerator << BigInt(-binaryExponent)
    ) < scaledDenominator;
  if (belowCandidatePower) binaryExponent -= 1;

  let significand;
  let result;
  if (binaryExponent >= -1022) {
    const significandShift = 52 - binaryExponent;
    significand = significandShift >= 0
      ? roundedQuotient(
        scaledNumerator << BigInt(significandShift),
        scaledDenominator,
      )
      : roundedQuotient(
        scaledNumerator,
        scaledDenominator << BigInt(-significandShift),
      );
    if (significand === (1n << 53n)) {
      significand >>= 1n;
      binaryExponent += 1;
    }
    result = Number(significand) * (2 ** (binaryExponent - 52));
  } else {
    significand = roundedQuotient(
      scaledNumerator << 1074n,
      scaledDenominator,
    );
    result = Number(significand) * Number.MIN_VALUE;
  }

  return negative ? -result : result;
};

const positiveDyadicRatio = (numerator, denominator) => {
  let scaledNumerator = numerator.coefficient;
  let scaledDenominator = denominator.coefficient;
  const dyadicExponent = numerator.exponent - denominator.exponent;
  if (dyadicExponent >= 0) {
    scaledNumerator <<= BigInt(dyadicExponent);
  } else {
    scaledDenominator <<= BigInt(-dyadicExponent);
  }

  const numeratorBits = scaledNumerator.toString(2).length;
  const denominatorBits = scaledDenominator.toString(2).length;
  let binaryExponent = numeratorBits - denominatorBits;
  const belowCandidatePower = binaryExponent >= 0
    ? scaledNumerator < (scaledDenominator << BigInt(binaryExponent))
    : (
      scaledNumerator << BigInt(-binaryExponent)
    ) < scaledDenominator;
  if (belowCandidatePower) binaryExponent -= 1;

  let result;
  if (binaryExponent >= -1022) {
    let significand = roundedQuotient(
      scaledNumerator << BigInt(52 - binaryExponent),
      scaledDenominator,
    );
    if (significand === (1n << 53n)) {
      significand >>= 1n;
      binaryExponent += 1;
    }
    result = Number(significand) * (2 ** (binaryExponent - 52));
  } else {
    const significand = roundedQuotient(
      scaledNumerator << 1074n,
      scaledDenominator,
    );
    result = Number(significand) * Number.MIN_VALUE;
  }

  if (result <= 0) return Number.MIN_VALUE;
  if (result >= 1) return 1 - Number.EPSILON / 2;
  return result;
};

const exactProjectionTerms = (point, start, end) => {
  let numerator = { coefficient: 0n, exponent: 0 };
  let denominator = { coefficient: 0n, exponent: 0 };
  let offsetSquared = { coefficient: 0n, exponent: 0 };
  const segments = [];
  for (let dimension = 0; dimension < point.length; dimension += 1) {
    const startValue = dyadicFromNumber(start[dimension]);
    const segment = subtractDyadic(
      dyadicFromNumber(end[dimension]),
      startValue,
    );
    segments.push(segment);
    const offset = subtractDyadic(
      dyadicFromNumber(point[dimension]),
      startValue,
    );
    numerator = addDyadic(
      numerator,
      multiplyDyadic(offset, segment),
    );
    denominator = addDyadic(
      denominator,
      multiplyDyadic(segment, segment),
    );
    offsetSquared = addDyadic(
      offsetSquared,
      multiplyDyadic(offset, offset),
    );
  }
  return {
    denominator,
    numerator,
    offsetSquared,
    segments,
  };
};

const exactInteriorProjection = (
  point,
  start,
  end,
  knownTerms,
) => {
  const {
    denominator,
    numerator,
    offsetSquared,
    segments,
  } = knownTerms ?? exactProjectionTerms(point, start, end);
  const residualNumerator = subtractDyadic(
    multiplyDyadic(offsetSquared, denominator),
    multiplyDyadic(numerator, numerator),
  );
  const collinear = residualNumerator.coefficient === 0n;
  const position = collinear
    ? point.slice()
    : start.map((value, dimension) => {
      const coordinateNumerator = addDyadic(
        multiplyDyadic(dyadicFromNumber(value), denominator),
        multiplyDyadic(segments[dimension], numerator),
      );
      const coordinate = dyadicRatioToNumber(
        coordinateNumerator,
        denominator,
      );
      return Object.is(coordinate, -0) ? 0 : coordinate;
    });
  const distanceAlong = positiveDyadicRatioSquareRoot(
    multiplyDyadic(numerator, numerator),
    denominator,
  );
  const remainingNumerator = subtractDyadic(denominator, numerator);
  const distanceToEnd = positiveDyadicRatioSquareRoot(
    multiplyDyadic(remainingNumerator, remainingNumerator),
    denominator,
  );
  if (residualNumerator.coefficient === 0n) {
    return {
      collinear,
      distance: 0,
      distanceAlong,
      distanceToEnd,
      fraction: positiveDyadicRatio(numerator, denominator),
      position,
    };
  }
  return {
    collinear,
    distance: positiveDyadicRatioSquareRoot(
      residualNumerator,
      denominator,
    ),
    distanceAlong,
    distanceToEnd,
    fraction: positiveDyadicRatio(numerator, denominator),
    position,
  };
};

export const robustProjection = (
  point,
  start,
  end,
  knownSegment,
) => {
  const segment = knownSegment ?? start.map(
    (value, dimension) => end[dimension] - value,
  );
  if (segment.some((value) => !Number.isFinite(value))) {
    throw new TypeError("segment length must remain finite");
  }
  if (segment.every((value) => value === 0)) {
    return {
      distance: null,
      distanceAlong: null,
      distanceToEnd: null,
      fraction: null,
      orderNumerator: null,
      position: null,
    };
  }
  const terms = exactProjectionTerms(point, start, end);
  if (terms.numerator.coefficient <= 0n) {
    return {
      distance: Math.hypot(...point.map(
        (value, dimension) => value - start[dimension],
      )),
      distanceAlong: 0,
      distanceToEnd: positiveDyadicRatioSquareRoot(
        terms.denominator,
        { coefficient: 1n, exponent: 0 },
      ),
      fraction: 0,
      orderNumerator: terms.numerator,
      position: start.slice(),
    };
  }
  if (compareDyadic(terms.numerator, terms.denominator) >= 0) {
    return {
      distance: Math.hypot(...point.map(
        (value, dimension) => value - end[dimension],
      )),
      distanceAlong: positiveDyadicRatioSquareRoot(
        terms.denominator,
        { coefficient: 1n, exponent: 0 },
      ),
      distanceToEnd: 0,
      fraction: 1,
      orderNumerator: terms.numerator,
      position: end.slice(),
    };
  }
  const projection = exactInteriorProjection(
    point,
    start,
    end,
    terms,
  );
  return {
    distance: projection.distance,
    distanceAlong: projection.distanceAlong,
    distanceToEnd: projection.distanceToEnd,
    fraction: projection.fraction,
    orderNumerator: terms.numerator,
    position: projection.position,
  };
};
