import { describe, expect, it } from 'vitest';

import { BuildLinearSeries, TestConfig } from '../Fixtures/ScoringFixtures';
import { RobustZNormalizer } from '../../src/Scoring/Normalizers/RobustZNormalizer';

describe('RobustZNormalizer', () => {
  const normalizer = new RobustZNormalizer(TestConfig);
  const values = BuildLinearSeries(101, 0, 100);

  it('scores the cohort median at the midpoint', () => {
    const stats = normalizer.BuildCohortStats(values, 'taxi_out_p50', 'Large');
    const normalized = normalizer.Normalize(stats.median, stats, 'taxi_out_p50');
    expect(normalized.normalizedScore).toBeCloseTo(50, 6);
  });

  it('reads higher_is_better metrics from the investor angle', () => {
    // Long taxi-out is bad for travellers but signals a binding airfield
    // constraint, which is what an expansion thesis is hunting for.
    const stats = normalizer.BuildCohortStats(values, 'taxi_out_p50', 'Large');
    const high = normalizer.Normalize(90, stats, 'taxi_out_p50');
    const low = normalizer.Normalize(10, stats, 'taxi_out_p50');

    expect(high.normalizedScore).toBeGreaterThan(50);
    expect(low.normalizedScore).toBeLessThan(50);
  });

  it('keeps every output inside 0-100', () => {
    const stats = normalizer.BuildCohortStats(values, 'avg_load_factor', 'Large');
    for (const candidate of [-1000, 0, 50, 100, 1e9]) {
      const normalized = normalizer.Normalize(candidate, stats, 'avg_load_factor');
      expect(normalized.normalizedScore).toBeGreaterThanOrEqual(0);
      expect(normalized.normalizedScore).toBeLessThanOrEqual(100);
    }
  });

  it('respects the subscore floor that keeps geometric aggregation stable', () => {
    const stats = normalizer.BuildCohortStats(values, 'avg_load_factor', 'Large');
    const extreme = normalizer.Normalize(-1e9, stats, 'avg_load_factor');
    expect(extreme.normalizedScore).toBeGreaterThanOrEqual(TestConfig.normalization.subscoreFloor);
  });

  /**
   * A metric where every airport reported the same value carries no
   * discriminating information. Scoring everyone at the midpoint is the
   * honest outcome — the alternative is dividing by zero and inventing
   * a ranking out of floating-point noise.
   */
  it('scores a zero-variance cohort at the midpoint instead of dividing by zero', () => {
    const flat = new Array(20).fill(42);
    const stats = normalizer.BuildCohortStats(flat, 'taxi_out_p50', 'Small');

    expect(stats.scaledMad).toBe(0);
    const normalized = normalizer.Normalize(42, stats, 'taxi_out_p50');
    expect(normalized.normalizedScore).toBeCloseTo(50, 6);
    expect(Number.isFinite(normalized.robustZ)).toBe(true);
  });

  /**
   * Median/MAD rather than mean/stdev is the reason the model tolerates the
   * handful of mega-hubs that would otherwise drag the centre and compress
   * everyone else into a narrow band.
   */
  it('is barely moved by an extreme outlier, unlike the mean', () => {
    const polluted = [...values, 1e7];

    const withoutOutlier = normalizer.BuildCohortStats(values, 'taxi_out_p50', 'Large');
    const withOutlier = normalizer.BuildCohortStats(polluted, 'taxi_out_p50', 'Large');

    // The median shifts only by the half-step that one extra element implies.
    const medianShift = Math.abs(withOutlier.median - withoutOutlier.median);
    expect(medianShift).toBeLessThan(1);

    // The mean, which this model deliberately does not use, is destroyed by
    // the same single value — which is the whole reason for median/MAD.
    const meanBefore = values.reduce((sum, value) => sum + value, 0) / values.length;
    const meanAfter = polluted.reduce((sum, value) => sum + value, 0) / polluted.length;
    expect(Math.abs(meanAfter - meanBefore)).toBeGreaterThan(10_000);

    // And the outlier itself is winsorized rather than allowed to dominate.
    const normalized = normalizer.Normalize(1e7, withOutlier, 'taxi_out_p50');
    expect(normalized.winsorizedValue).toBeLessThanOrEqual(withOutlier.winsorUpperBound);
  });

  it('handles an empty cohort without throwing', () => {
    const stats = normalizer.BuildCohortStats([], 'spill_rate', 'Nonhub');
    expect(stats.sampleSize).toBe(0);
    expect(() => normalizer.Normalize(0.1, stats, 'spill_rate')).not.toThrow();
  });

  it('is monotonic across the range', () => {
    const stats = normalizer.BuildCohortStats(values, 'avg_load_factor', 'Large');
    const ascending = [10, 30, 50, 70, 90].map(
      (value) => normalizer.Normalize(value, stats, 'avg_load_factor').normalizedScore,
    );

    for (let index = 1; index < ascending.length; index += 1) {
      expect(ascending[index]).toBeGreaterThan(ascending[index - 1]);
    }
  });
});
