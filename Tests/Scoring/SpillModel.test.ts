import { describe, expect, it } from 'vitest';

import { BuildTrafficMonth } from '../Fixtures/ScoringFixtures';
import { ExpectedBoardings, StandardNormalCdf } from '../../src/Infrastructure/Math/NormalDistribution';
import { SpillModel } from '../../src/Scoring/Spill/SpillModel';

const KFactor = 0.35;

describe('NormalDistribution', () => {
  it('matches known values of the standard normal CDF', () => {
    expect(StandardNormalCdf(0)).toBeCloseTo(0.5, 6);
    expect(StandardNormalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(StandardNormalCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(StandardNormalCdf(1)).toBeCloseTo(0.8413, 3);
  });

  it('caps expected boardings below both demand and capacity', () => {
    // With capacity far above demand, essentially everyone flies.
    expect(ExpectedBoardings(100, 35, 10_000)).toBeCloseTo(100, 3);
    // With capacity far below demand, the aircraft simply fills.
    expect(ExpectedBoardings(10_000, 3_500, 100)).toBeLessThanOrEqual(100);
  });
});

describe('SpillModel', () => {
  const model = new SpillModel(KFactor);

  /**
   * The inversion is the heart of the model, so it is checked by round-trip:
   * pick a latent demand, compute the boardings it would produce against a
   * known seat count, hand those boardings back, and confirm the original
   * demand is recovered.
   */
  it('recovers latent demand by round-trip', () => {
    const trueDemand = 120_000;
    const seats = 100_000;
    const observedPassengers = ExpectedBoardings(trueDemand, KFactor * trueDemand, seats);

    const estimate = model.EstimateMonth(
      BuildTrafficMonth({ seats, passengers: Math.round(observedPassengers) }),
    );

    expect(estimate).not.toBeNull();
    expect(estimate?.estimatedDemand).toBeCloseTo(trueDemand, -2);
  });

  it('never reports demand below observed boardings', () => {
    for (const loadFactor of [0.2, 0.5, 0.75, 0.9, 0.99]) {
      const seats = 100_000;
      const estimate = model.EstimateMonth(
        BuildTrafficMonth({ seats, passengers: Math.round(seats * loadFactor) }),
      );
      expect(estimate).not.toBeNull();
      expect(estimate!.estimatedDemand).toBeGreaterThanOrEqual(estimate!.passengers - 1);
      expect(estimate!.spilledPassengers).toBeGreaterThanOrEqual(0);
    }
  });

  /**
   * The core intuition the model exists to capture: an airport at 95% load
   * factor is not "5% empty", it is turning people away on the full days.
   * Spill must therefore rise with load factor.
   */
  it('increases spill as load factor rises', () => {
    const seats = 100_000;
    const rates = [0.3, 0.5, 0.7, 0.85, 0.95].map((loadFactor) => {
      const estimate = model.EstimateMonth(
        BuildTrafficMonth({ seats, passengers: Math.round(seats * loadFactor) }),
      );
      return estimate?.spillRate ?? 0;
    });

    for (let index = 1; index < rates.length; index += 1) {
      expect(rates[index]).toBeGreaterThan(rates[index - 1]);
    }
  });

  it('finds almost no spill at a very low load factor', () => {
    const estimate = model.EstimateMonth(BuildTrafficMonth({ seats: 100_000, passengers: 20_000 }));
    expect(estimate?.spillRate ?? 1).toBeLessThan(0.01);
  });

  it('returns null rather than a fabricated number when capacity data is missing', () => {
    expect(model.EstimateMonth(BuildTrafficMonth({ seats: 0, passengers: 0 }))).toBeNull();
    expect(model.EstimateMonth(BuildTrafficMonth({ seats: 100, passengers: 0 }))).toBeNull();
  });

  it('weights the aggregate by volume, not by month count', () => {
    const bigFullMonth = BuildTrafficMonth({ monthKey: '2026-01', seats: 1_000_000, passengers: 950_000 });
    const tinyEmptyMonth = BuildTrafficMonth({ monthKey: '2026-02', seats: 1_000, passengers: 300 });

    const aggregate = model.AggregateSpillRate([bigFullMonth, tinyEmptyMonth]);
    expect(aggregate).not.toBeNull();

    const bigAlone = model.EstimateMonth(bigFullMonth)!.spillRate;
    // The tiny near-empty month must barely move the result.
    expect(Math.abs((aggregate?.spillRate ?? 0) - bigAlone)).toBeLessThan(0.01);
  });

  it('returns null for an aggregate with no usable months', () => {
    expect(model.AggregateSpillRate([])).toBeNull();
    expect(model.AggregateSpillRate([BuildTrafficMonth({ seats: 0, passengers: 0 })])).toBeNull();
  });

  it('produces more spill at a higher k-factor, holding load constant', () => {
    const month = BuildTrafficMonth({ seats: 100_000, passengers: 85_000 });
    const steady = new SpillModel(0.3).EstimateMonth(month)!.spillRate;
    const volatile = new SpillModel(0.5).EstimateMonth(month)!.spillRate;

    // More variable demand spills more at the same average load factor.
    expect(volatile).toBeGreaterThan(steady);
  });
});
