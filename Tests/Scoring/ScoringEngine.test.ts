import { describe, expect, it } from 'vitest';

import { AggregatorFactory } from '../../src/Scoring/Aggregators/AggregatorFactory';
import { ArithmeticAggregator } from '../../src/Scoring/Aggregators/ArithmeticAggregator';
import { BuildAirport, TestConfig } from '../Fixtures/ScoringFixtures';
import { CoverageEvaluator } from '../../src/Scoring/Coverage/CoverageEvaluator';
import { FeasibilityAdjuster } from '../../src/Scoring/Feasibility/FeasibilityAdjuster';
import { GeometricAggregator } from '../../src/Scoring/Aggregators/GeometricAggregator';
import {
  InMemoryAirportRepository,
  InMemoryFacilityRepository,
  InMemoryMetricRepository,
} from '../Fixtures/InMemoryRepositories';
import { AllMetricIds } from '../../src/Metrics/MetricRegistry';
import { PillarCalculator } from '../../src/Scoring/Pillars/PillarCalculator';
import { RobustZNormalizer } from '../../src/Scoring/Normalizers/RobustZNormalizer';
import { ScaleAdjuster } from '../../src/Scoring/Scale/ScaleAdjuster';
import { ScoringEngine } from '../../src/Scoring/ScoringEngine';
import { WaterfallBuilder } from '../../src/Scoring/Explain/WaterfallBuilder';
import type { Airport } from '../../src/Types/Domain/Airport';
import type { AirportFacilityRecord } from '../../src/Types/Domain/Facility';
import type { MetricValueRow } from '../../src/Types/Ports/Repositories';

/**
 * End-to-end scoring against in-memory fixtures.
 *
 * No database, no mocking library — the composition root simply receives
 * different implementations. That is the payoff of constructor injection.
 */

/** Gives an airport the same normalized position on every metric. */
function MetricsFor(iata: string, percentile: number): MetricValueRow[] {
  return AllMetricIds.map((metricId) => ({ iata, metricId, value: percentile, sampleSize: 12 }));
}

function BuildEngine(
  airports: Airport[],
  rows: MetricValueRow[],
  facilities: AirportFacilityRecord[] = [],
) {
  return new ScoringEngine(
    new InMemoryAirportRepository(airports),
    new InMemoryMetricRepository(rows),
    new RobustZNormalizer(TestConfig),
    new PillarCalculator(),
    new CoverageEvaluator(TestConfig),
    new AggregatorFactory(new GeometricAggregator(), new ArithmeticAggregator()),
    new FeasibilityAdjuster(new InMemoryFacilityRepository(facilities)),
    new ScaleAdjuster(TestConfig.scale),
    new WaterfallBuilder(),
    TestConfig,
  );
}

/** A cohort spread across the range, so normalization has something to work with. */
function BuildCohort(hubClass: Airport['hubClass'], enplanements: number, count = 9) {
  const airports: Airport[] = [];
  const rows: MetricValueRow[] = [];

  for (let index = 0; index < count; index += 1) {
    const iata = `${hubClass.slice(0, 1)}${String(index).padStart(2, '0')}`;
    airports.push(BuildAirport({ iata, name: `${hubClass} ${index}`, hubClass, annualEnplanements: enplanements }));
    rows.push(...MetricsFor(iata, 10 + index * 10));
  }
  return { airports, rows };
}

describe('ScoringEngine', () => {
  it('ranks by score, descending', () => {
    const { airports, rows } = BuildCohort('Large', 20_000_000);
    const engine = BuildEngine(airports, rows);

    const result = engine.Rank({ airports, periodId: 'test', overrides: { scaleWeighting: 'none' } });

    expect(result.scores.length).toBeGreaterThan(1);
    for (let index = 1; index < result.scores.length; index += 1) {
      expect(result.scores[index - 1].score).toBeGreaterThanOrEqual(result.scores[index].score);
      expect(result.scores[index].rank).toBe(index + 1);
    }
  });

  it('produces a waterfall that sums to the score for every airport', () => {
    const { airports, rows } = BuildCohort('Medium', 3_000_000);
    const engine = BuildEngine(airports, rows);

    const result = engine.Rank({ airports, periodId: 'test', overrides: {} });

    for (const score of result.scores) {
      const summed = score.waterfall.terms.reduce((total, term) => total + term.amount, 0);
      expect(summed).toBeCloseTo(score.score, 6);
    }
  });

  /**
   * Reproduces the defect found on the first real run: cohort-relative
   * normalization let a best-in-class nonhub outrank a strong mega-hub.
   * Materiality must reverse that, and switching it off must restore the
   * intensity-only view.
   */
  it('lets materiality decide between a strong small airport and a good mega-hub', () => {
    const nonhub = BuildCohort('Nonhub', 250_000);
    const large = BuildCohort('Large', 21_000_000);

    // Best of the nonhubs, mid-pack among the large hubs.
    const airports = [...nonhub.airports, ...large.airports];
    const rows = [...nonhub.rows, ...large.rows];
    const engine = BuildEngine(airports, rows);

    const topNonhub = nonhub.airports[nonhub.airports.length - 1];
    const midLarge = large.airports[large.airports.length - 2];

    const intensityOnly = engine.ScoreUniverse('test', { scaleWeighting: 'none' });
    expect(intensityOnly[topNonhub.iata].score).toBeGreaterThan(intensityOnly[midLarge.iata].score);

    const withMateriality = engine.ScoreUniverse('test', { scaleWeighting: 'strong' });
    expect(withMateriality[midLarge.iata].score).toBeGreaterThan(withMateriality[topNonhub.iata].score);
  });

  it('normalizes within cohort, so identical peers score identically regardless of size', () => {
    const small = BuildCohort('Small', 900_000);
    const large = BuildCohort('Large', 25_000_000);

    const engine = BuildEngine([...small.airports, ...large.airports], [...small.rows, ...large.rows]);
    const scores = engine.ScoreUniverse('test', { scaleWeighting: 'none' });

    // Same position within their own cohorts -> same score once size is ignored.
    const smallTop = scores[small.airports[small.airports.length - 1].iata];
    const largeTop = scores[large.airports[large.airports.length - 1].iata];

    expect(smallTop.score).toBeCloseTo(largeTop.score, 6);
    expect(smallTop.cohortPercentile).toBeCloseTo(largeTop.cohortPercentile, 6);
  });

  it('applies feasibility penalties from curated flags', () => {
    const { airports, rows } = BuildCohort('Large', 20_000_000);
    const constrained = airports[airports.length - 1];

    const engine = BuildEngine(airports, rows, [
      {
        iata: constrained.iata,
        feasibility: { slotControlled: true, perimeterRule: true, landConstrained: false },
      },
    ]);

    const scores = engine.ScoreUniverse('test', { scaleWeighting: 'none' });
    // 0.8 slot-controlled x 0.9 perimeter rule.
    expect(scores[constrained.iata].feasibilityMultiplier).toBeCloseTo(0.72, 6);
  });

  it('treats a land-constrained airport as a penalty for airfield and a bonus for terminal work', () => {
    const { airports, rows } = BuildCohort('Medium', 4_000_000);
    const boxedIn = airports[0];

    const engine = BuildEngine(airports, rows, [
      {
        iata: boxedIn.iata,
        feasibility: { slotControlled: false, perimeterRule: false, landConstrained: true },
      },
    ]);

    const airfield = engine.ScoreUniverse('test', { profile: 'airfield', scaleWeighting: 'none' });
    const terminal = engine.ScoreUniverse('test', { profile: 'terminal', scaleWeighting: 'none' });

    expect(airfield[boxedIn.iata].feasibilityMultiplier).toBeCloseTo(0.85, 6);
    expect(terminal[boxedIn.iata].feasibilityMultiplier).toBeCloseTo(1.05, 6);
  });

  it('excludes an airport with no metrics and explains why', () => {
    const { airports, rows } = BuildCohort('Small', 800_000);
    const dark = BuildAirport({
      iata: 'DRK',
      name: 'Dark Regional',
      hubClass: 'Small',
      reportsOnTimePerformance: false,
    });

    const engine = BuildEngine([...airports, dark], rows);
    const result = engine.Rank({ airports: [...airports, dark], periodId: 'test', overrides: {} });

    expect(result.scores.some((score) => score.iata === 'DRK')).toBe(false);

    const exclusion = result.exclusions.find((entry) => entry.iata === 'DRK');
    expect(exclusion).toBeDefined();
    expect(exclusion!.explanation).toContain('Dark Regional');
    expect(exclusion!.explanation.length).toBeGreaterThan(40);
  });

  it('reports every considered airport as either ranked or excluded', () => {
    const { airports, rows } = BuildCohort('Medium', 2_000_000);
    const dark = BuildAirport({ iata: 'DRK', hubClass: 'Medium', reportsOnTimePerformance: false });

    const engine = BuildEngine([...airports, dark], rows);
    const result = engine.Rank({ airports: [...airports, dark], periodId: 'test', overrides: {} });

    expect(result.consideredCount).toBe(airports.length + 1);
    expect(result.scores.length + result.exclusions.length).toBe(result.consideredCount);
  });

  it('changes results when the aggregation mode is switched', () => {
    const { airports, rows } = BuildCohort('Large', 18_000_000);
    // Make one airport deliberately lopsided: strong constraint, weak payoff.
    const lopsided = airports[0].iata;
    const adjusted = rows.map((row) =>
      row.iata === lopsided && row.metricId === 'intl_pax_share' ? { ...row, value: 1 } : row,
    );

    const engine = BuildEngine(airports, adjusted);
    const geometric = engine.ScoreUniverse('test', { aggregation: 'geometric', scaleWeighting: 'none' });
    const arithmetic = engine.ScoreUniverse('test', { aggregation: 'arithmetic', scaleWeighting: 'none' });

    expect(geometric[lopsided].score).not.toBeCloseTo(arithmetic[lopsided].score, 3);
    expect(geometric[lopsided].aggregation).toBe('geometric');
    expect(arithmetic[lopsided].aggregation).toBe('arithmetic');
  });

  it('is deterministic: the same inputs always give the same score', () => {
    const { airports, rows } = BuildCohort('Large', 15_000_000);
    const engine = BuildEngine(airports, rows);

    const first = engine.ScoreUniverse('test', {});
    const second = engine.ScoreUniverse('test', {});

    for (const iata of Object.keys(first)) {
      expect(second[iata].score).toBe(first[iata].score);
    }
  });
});
