import { describe, expect, it } from 'vitest';

import { AggregatorFactory, UnknownAggregationModeError } from '../../src/Scoring/Aggregators/AggregatorFactory';
import { ArithmeticAggregator } from '../../src/Scoring/Aggregators/ArithmeticAggregator';
import { GeometricAggregator } from '../../src/Scoring/Aggregators/GeometricAggregator';
import type { AggregationMode } from '../../src/Types/Scoring/ScoringConfig';

const NeedExponent = 0.65;
const PayoffExponent = 0.35;

describe('Aggregators', () => {
  const geometric = new GeometricAggregator();
  const arithmetic = new ArithmeticAggregator();

  /**
   * This is the test that justifies geometric being the default.
   *
   * Airport A is badly congested with nothing worth monetising.
   * Airport B is balanced across both.
   *
   * Arithmetic lets A's congestion compensate for its near-dead payoff and
   * ranks it first. Geometric requires both halves of the investment thesis
   * to hold, and ranks B first. If this test ever flips, the scoring model
   * has silently stopped encoding the thesis it claims to.
   */
  it('disagrees on unbalanced airports, which is the entire point', () => {
    const unbalanced = { need: 90, payoff: 20 };
    const balanced = { need: 55, payoff: 55 };

    const arithmeticUnbalanced = arithmetic.Combine(unbalanced.need, unbalanced.payoff, NeedExponent, PayoffExponent);
    const arithmeticBalanced = arithmetic.Combine(balanced.need, balanced.payoff, NeedExponent, PayoffExponent);

    const geometricUnbalanced = geometric.Combine(unbalanced.need, unbalanced.payoff, NeedExponent, PayoffExponent);
    const geometricBalanced = geometric.Combine(balanced.need, balanced.payoff, NeedExponent, PayoffExponent);

    expect(arithmeticUnbalanced).toBeCloseTo(65.5, 1);
    expect(arithmeticBalanced).toBeCloseTo(55.0, 1);
    expect(arithmeticUnbalanced).toBeGreaterThan(arithmeticBalanced);

    expect(geometricUnbalanced).toBeCloseTo(53.2, 1);
    expect(geometricBalanced).toBeCloseTo(55.0, 1);
    expect(geometricBalanced).toBeGreaterThan(geometricUnbalanced);
  });

  it('agrees when the pillars are equal', () => {
    const value = 70;
    expect(geometric.Combine(value, value, NeedExponent, PayoffExponent)).toBeCloseTo(value, 6);
    expect(arithmetic.Combine(value, value, NeedExponent, PayoffExponent)).toBeCloseTo(value, 6);
  });

  it('never penalises balance: geometric is at most arithmetic', () => {
    const samples = [
      [10, 90],
      [90, 10],
      [50, 50],
      [80, 20],
      [33, 67],
    ];

    for (const [need, payoff] of samples) {
      const geometricValue = geometric.Combine(need, payoff, NeedExponent, PayoffExponent);
      const arithmeticValue = arithmetic.Combine(need, payoff, NeedExponent, PayoffExponent);
      // AM-GM inequality: the weighted geometric mean never exceeds the
      // weighted arithmetic mean, with equality only when the two are equal.
      expect(geometricValue).toBeLessThanOrEqual(arithmeticValue + 1e-9);
    }
  });

  /**
   * Geometric aggregation collapses hard near zero. The subscore floor in
   * normalization is what keeps it well behaved, but the aggregator itself
   * must never emit NaN or Infinity regardless of what it is handed.
   */
  it('stays finite at and below zero', () => {
    for (const value of [0, -5, Number.EPSILON]) {
      const result = geometric.Combine(value, 50, NeedExponent, PayoffExponent);
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });

  it('is monotonic in both inputs', () => {
    const low = geometric.Combine(40, 50, NeedExponent, PayoffExponent);
    const higherNeed = geometric.Combine(60, 50, NeedExponent, PayoffExponent);
    const higherPayoff = geometric.Combine(40, 70, NeedExponent, PayoffExponent);

    expect(higherNeed).toBeGreaterThan(low);
    expect(higherPayoff).toBeGreaterThan(low);
  });
});

describe('AggregatorFactory', () => {
  const factory = new AggregatorFactory(new GeometricAggregator(), new ArithmeticAggregator());

  it('resolves both supported modes', () => {
    expect(factory.Resolve('geometric').mode).toBe('geometric');
    expect(factory.Resolve('arithmetic').mode).toBe('arithmetic');
  });

  it('throws a named error on an unknown mode rather than silently defaulting', () => {
    expect(() => factory.Resolve('harmonic' as AggregationMode)).toThrow(UnknownAggregationModeError);
  });
});
