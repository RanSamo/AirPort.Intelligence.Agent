import { describe, expect, it } from 'vitest';

import { BuildAirport, TestConfig } from '../Fixtures/ScoringFixtures';
import { CoverageEvaluator } from '../../src/Scoring/Coverage/CoverageEvaluator';
import { GetMetricsForPillar } from '../../src/Metrics/MetricRegistry';
import { PillarCalculator } from '../../src/Scoring/Pillars/PillarCalculator';
import type { MetricId } from '../../src/Types/Domain/Metric';
import type { NormalizedMetricValue } from '../../src/Types/Scoring/Normalization';

function Normalized(metricId: MetricId, normalizedScore: number): NormalizedMetricValue {
  return { metricId, rawValue: 0, winsorizedValue: 0, robustZ: 0, normalizedScore };
}

const EvenWeights = GetMetricsForPillar('constraint').reduce(
  (accumulator: { [metricId: string]: number }, metricId) => {
    accumulator[metricId] = 1;
    return accumulator;
  },
  {},
);

describe('CoverageEvaluator', () => {
  const evaluator = new CoverageEvaluator(TestConfig);
  const constraintMetrics = GetMetricsForPillar('constraint');

  it('reports full coverage when every metric is present', () => {
    const coverage = evaluator.Evaluate('constraint', constraintMetrics, EvenWeights);
    expect(coverage.ratio).toBeCloseTo(1, 6);
    expect(coverage.missingMetrics).toHaveLength(0);
    expect(coverage.confidence).toBe('high');
  });

  it('reports zero coverage when nothing is available', () => {
    const coverage = evaluator.Evaluate('constraint', [], EvenWeights);
    expect(coverage.ratio).toBe(0);
    expect(coverage.confidence).toBe('low');
    expect(coverage.missingMetrics).toHaveLength(constraintMetrics.length);
  });

  it('weights coverage rather than counting metrics', () => {
    const weighted = { ...EvenWeights, [constraintMetrics[0]]: 9 };
    const totalWeight = constraintMetrics.length - 1 + 9;

    const onlyHeavy = evaluator.Evaluate('constraint', [constraintMetrics[0]], weighted);
    expect(onlyHeavy.ratio).toBeCloseTo(9 / totalWeight, 6);

    // One heavy metric outweighs every light one put together.
    const allButHeavy = evaluator.Evaluate('constraint', constraintMetrics.slice(1), weighted);
    expect(onlyHeavy.ratio).toBeGreaterThan(allButHeavy.ratio);
  });

  /**
   * Exclusions must never read as a bare "insufficient data" — the reason has
   * to name what is missing and why it mattered for the question asked.
   */
  it('explains an OTP-less airport specifically', () => {
    const airport = BuildAirport({ iata: 'HVN', name: 'Tweed New Haven', reportsOnTimePerformance: false });
    const coverage = evaluator.Evaluate('constraint', [], EvenWeights);

    const exclusion = evaluator.BuildExclusion(
      airport,
      { constraint: coverage },
      { profileId: 'terminal', profileLabel: 'Terminal expansion' },
      TestConfig,
    );

    expect(exclusion.code).toBe('not_otp_reporting');
    expect(exclusion.explanation).toContain('Tweed New Haven');
    expect(exclusion.explanation).toContain('On-Time Performance');
    expect(exclusion.explanation).toContain('terminal expansion');
    expect(exclusion.explanation).not.toMatch(/insufficient data/i);
  });

  it('distinguishes an airport with no traffic at all', () => {
    const airport = BuildAirport({ iata: 'ZZZ', annualEnplanements: 0 });
    const exclusion = evaluator.BuildExclusion(
      airport,
      { constraint: evaluator.Evaluate('constraint', [], EvenWeights) },
      { profileId: 'balanced', profileLabel: 'Balanced' },
      TestConfig,
    );

    expect(exclusion.code).toBe('no_traffic_data');
  });
});

describe('PillarCalculator', () => {
  const calculator = new PillarCalculator();
  const evaluator = new CoverageEvaluator(TestConfig);
  const constraintMetrics = GetMetricsForPillar('constraint');

  it('averages the weighted metric scores', () => {
    const normalized = constraintMetrics.map((metricId) => Normalized(metricId, 60));
    const coverage = evaluator.Evaluate('constraint', constraintMetrics, EvenWeights);

    const pillar = calculator.Calculate('constraint', normalized, EvenWeights, coverage);
    expect(pillar.score).toBeCloseTo(60, 6);
  });

  /**
   * The whole missing-data policy in one assertion: an absent metric must not
   * drag the pillar toward zero. Weights renormalize over what is present,
   * and the gap shows up as reduced coverage instead.
   */
  it('renormalizes over available metrics instead of imputing zeros', () => {
    const partial = [Normalized(constraintMetrics[0], 80), Normalized(constraintMetrics[1], 80)];
    const coverage = evaluator.Evaluate('constraint', [constraintMetrics[0], constraintMetrics[1]], EvenWeights);

    const pillar = calculator.Calculate('constraint', partial, EvenWeights, coverage);

    expect(pillar.score).toBeCloseTo(80, 6);
    expect(pillar.coverage.ratio).toBeLessThan(1);
  });

  it('falls back to the cohort midpoint when nothing is available', () => {
    const coverage = evaluator.Evaluate('constraint', [], EvenWeights);
    const pillar = calculator.Calculate('constraint', [], EvenWeights, coverage);

    expect(pillar.score).toBe(50);
    expect(pillar.contributions).toHaveLength(0);
  });

  it('keeps contributions that sum to the pillar score', () => {
    const normalized = [
      Normalized(constraintMetrics[0], 90),
      Normalized(constraintMetrics[1], 30),
      Normalized(constraintMetrics[2], 60),
    ];
    const coverage = evaluator.Evaluate('constraint', constraintMetrics.slice(0, 3), EvenWeights);
    const pillar = calculator.Calculate('constraint', normalized, EvenWeights, coverage);

    const summed = pillar.contributions.reduce((total, contribution) => total + contribution.contribution, 0);
    expect(summed).toBeCloseTo(pillar.score, 6);

    const weights = pillar.contributions.reduce((total, contribution) => total + contribution.effectiveWeight, 0);
    expect(weights).toBeCloseTo(1, 6);
  });

  it('ignores metrics carrying zero weight', () => {
    const zeroed = { ...EvenWeights, [constraintMetrics[0]]: 0 };
    const normalized = [Normalized(constraintMetrics[0], 100), Normalized(constraintMetrics[1], 40)];
    const coverage = evaluator.Evaluate('constraint', [constraintMetrics[1]], zeroed);

    const pillar = calculator.Calculate('constraint', normalized, zeroed, coverage);
    expect(pillar.score).toBeCloseTo(40, 6);
  });
});
