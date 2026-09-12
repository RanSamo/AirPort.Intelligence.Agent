import { describe, expect, it } from 'vitest';

import { AggregatorFactory } from '../../src/Scoring/Aggregators/AggregatorFactory';
import { AllMetricIds, MetricsById } from '../../src/Metrics/MetricRegistry';
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
import { PillarCalculator } from '../../src/Scoring/Pillars/PillarCalculator';
import { RobustZNormalizer } from '../../src/Scoring/Normalizers/RobustZNormalizer';
import { ScaleAdjuster } from '../../src/Scoring/Scale/ScaleAdjuster';
import { ScoringEngine } from '../../src/Scoring/ScoringEngine';
import { SeededRandom } from '../../src/Infrastructure/Math/SeededRandom';
import { SensitivityAnalyzer } from '../../src/Scoring/Sensitivity/SensitivityAnalyzer';
import { WaterfallBuilder } from '../../src/Scoring/Explain/WaterfallBuilder';
import type { Airport } from '../../src/Types/Domain/Airport';
import type { MetricValueRow } from '../../src/Types/Ports/Repositories';

function MetricsFor(iata: string, percentile: number): MetricValueRow[] {
  return AllMetricIds.map((metricId) => ({ iata, metricId, value: percentile, sampleSize: 12 }));
}

/**
 * Gives an airport a *shape* rather than a flat percentile: strong on one
 * pillar, weak on another.
 *
 * This matters. An airport that is uniformly better on all 14 metrics cannot
 * be reordered by reweighting, so the analyzer rightly calls it robust.
 * Ties only arise between airports with different strengths — which is the
 * realistic case, and the one the analyzer exists to detect.
 */
function ShapedMetricsFor(iata: string, constraintLevel: number, monetizationLevel: number): MetricValueRow[] {
  return PillarMetricsFor(iata, {
    constraint: constraintLevel,
    latent_demand: constraintLevel,
    monetization: monetizationLevel,
  });
}

interface PillarLevels {
  [pillarId: string]: number;
}

/** Sets an independent level per pillar. */
function PillarMetricsFor(iata: string, levels: PillarLevels): MetricValueRow[] {
  return AllMetricIds.map((metricId) => ({
    iata,
    metricId,
    value: levels[MetricsById[metricId].pillar] ?? 50,
    sampleSize: 12,
  }));
}

function BuildAnalyzer(airports: Airport[], rows: MetricValueRow[]) {
  const engine = new ScoringEngine(
    new InMemoryAirportRepository(airports),
    new InMemoryMetricRepository(rows),
    new RobustZNormalizer(TestConfig),
    new PillarCalculator(),
    new CoverageEvaluator(TestConfig),
    new AggregatorFactory(new GeometricAggregator(), new ArithmeticAggregator()),
    new FeasibilityAdjuster(new InMemoryFacilityRepository([])),
    new ScaleAdjuster(TestConfig.scale),
    new WaterfallBuilder(),
    TestConfig,
  );
  return new SensitivityAnalyzer(engine, TestConfig);
}

/** A spread cohort with one runaway leader. */
function BuildDominantLeader() {
  const airports: Airport[] = [];
  const rows: MetricValueRow[] = [];

  airports.push(BuildAirport({ iata: 'TOP', name: 'Dominant', hubClass: 'Large', annualEnplanements: 20_000_000 }));
  rows.push(...MetricsFor('TOP', 99));

  for (let index = 0; index < 6; index += 1) {
    const iata = `R${index}`;
    airports.push(BuildAirport({ iata, name: `Rival ${index}`, hubClass: 'Large', annualEnplanements: 20_000_000 }));
    rows.push(...MetricsFor(iata, 10 + index * 8));
  }
  return { airports, rows };
}

describe('SeededRandom', () => {
  it('is reproducible for a given seed', () => {
    const first = Array.from({ length: 10 }, () => new SeededRandom(42).Next());
    expect(new Set(first).size).toBe(1);

    const a = new SeededRandom(7);
    const b = new SeededRandom(7);
    for (let index = 0; index < 20; index += 1) expect(a.Next()).toBe(b.Next());
  });

  it('differs across seeds', () => {
    expect(new SeededRandom(1).Next()).not.toBe(new SeededRandom(2).Next());
  });

  it('stays inside [0, 1)', () => {
    const random = new SeededRandom(123);
    for (let index = 0; index < 500; index += 1) {
      const value = random.Next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('produces weight factors centred on 1', () => {
    const random = new SeededRandom(99);
    const factors = Array.from({ length: 2000 }, () => random.NextWeightFactor(0.35));

    for (const factor of factors) expect(factor).toBeGreaterThan(0);

    // Log-normal is symmetric in proportion, so the median sits at 1.
    const sorted = [...factors].sort((left, right) => left - right);
    expect(sorted[Math.floor(sorted.length / 2)]).toBeCloseTo(1, 1);
  });
});

describe('SensitivityAnalyzer', () => {
  /**
   * The robustness figure must not move between identical questions, or it
   * would undermine the certainty it exists to establish.
   */
  it('is deterministic across runs', () => {
    const { airports, rows } = BuildDominantLeader();
    const analyzer = BuildAnalyzer(airports, rows);

    const first = analyzer.Analyze({ airports, periodId: 'test', overrides: {}, draws: 100 });
    const second = analyzer.Analyze({ airports, periodId: 'test', overrides: {}, draws: 100 });

    expect(second.narrative).toBe(first.narrative);
    expect(second.distributions.map((entry) => entry.probabilityInTopN)).toEqual(
      first.distributions.map((entry) => entry.probabilityInTopN),
    );
  });

  it('keeps a dominant airport at the top under every weighting', () => {
    const { airports, rows } = BuildDominantLeader();
    const analyzer = BuildAnalyzer(airports, rows);

    const result = analyzer.Analyze({ airports, periodId: 'test', overrides: {}, draws: 200, topN: 3 });
    const leader = result.distributions[0];

    expect(leader.iata).toBe('TOP');
    expect(leader.probabilityInTopN).toBe(1);
    expect(leader.probabilityAtBaselineRank).toBeGreaterThan(0.95);
    expect(result.isRankingRobust).toBe(true);
  });

  /**
   * The case that motivated this analyzer: airports separated by noise were
   * being printed as distinct ranks. Two identical airports must be reported
   * as tied rather than ordered.
   */
  it('detects a tie between indistinguishable airports', () => {
    const airports: Airport[] = [];
    const rows: MetricValueRow[] = [];

    // Mirror images that trade strengths WITHIN Need, where the weights are
    // 0.55 / 0.45 and therefore genuinely close. One is congestion-led, the
    // other demand-led; which leads depends entirely on the weighting, so
    // they must be reported as tied rather than ranked 1st and 2nd.
    airports.push(BuildAirport({ iata: 'TIE1', name: 'Twin One', hubClass: 'Small', annualEnplanements: 1_000_000 }));
    rows.push(...PillarMetricsFor('TIE1', { constraint: 70, latent_demand: 40, monetization: 55 }));

    airports.push(BuildAirport({ iata: 'TIE2', name: 'Twin Two', hubClass: 'Small', annualEnplanements: 1_000_000 }));
    rows.push(...PillarMetricsFor('TIE2', { constraint: 40, latent_demand: 70, monetization: 55 }));

    // Clearly weaker field, so the twins are the adjacent top pair.
    for (let index = 0; index < 4; index += 1) {
      const iata = `O${index}`;
      airports.push(BuildAirport({ iata, name: `Other ${index}`, hubClass: 'Small', annualEnplanements: 1_000_000 }));
      rows.push(...MetricsFor(iata, 10 + index * 5));
    }

    const analyzer = BuildAnalyzer(airports, rows);
    const result = analyzer.Analyze({ airports, periodId: 'test', overrides: {}, draws: 300 });

    const tie = result.ties.find(
      (entry) =>
        (entry.iata === 'TIE1' && entry.otherIata === 'TIE2') ||
        (entry.iata === 'TIE2' && entry.otherIata === 'TIE1'),
    );

    expect(tie).toBeDefined();
    expect(tie!.swapRate).toBeGreaterThan(0.3);
    expect(tie!.narrative).toContain('tied');
  });

  it('reports a rank range that contains the baseline rank', () => {
    const { airports, rows } = BuildDominantLeader();
    const analyzer = BuildAnalyzer(airports, rows);
    const result = analyzer.Analyze({ airports, periodId: 'test', overrides: {}, draws: 150 });

    for (const entry of result.distributions) {
      expect(entry.bestRank).toBeLessThanOrEqual(entry.worstRank);
      expect(entry.medianRank).toBeGreaterThanOrEqual(entry.bestRank);
      expect(entry.medianRank).toBeLessThanOrEqual(entry.worstRank);
      expect(entry.probabilityInTopN).toBeGreaterThanOrEqual(0);
      expect(entry.probabilityInTopN).toBeLessThanOrEqual(1);
    }
  });

  /**
   * Airports with opposing strengths and similar overall quality should not
   * hold a stable order — which is precisely what the New England result
   * turned out to look like.
   */
  it('reports an unstable order when airports trade strengths', () => {
    const airports: Airport[] = [];
    const rows: MetricValueRow[] = [];

    for (let index = 0; index < 6; index += 1) {
      const iata = `C${index}`;
      airports.push(BuildAirport({ iata, hubClass: 'Medium', annualEnplanements: 2_000_000 }));
      // Constraint climbs while monetization falls, so total quality is
      // similar but the ordering depends entirely on the weighting.
      rows.push(...ShapedMetricsFor(iata, 40 + index * 4, 60 - index * 4));
    }

    const analyzer = BuildAnalyzer(airports, rows);
    const result = analyzer.Analyze({ airports, periodId: 'test', overrides: {}, draws: 300 });

    const holdRates = result.distributions.map((entry) => entry.probabilityAtBaselineRank);
    expect(Math.max(...holdRates)).toBeLessThan(0.95);
    expect(result.ties.length).toBeGreaterThan(0);
  });

  /**
   * The converse, and an important non-obvious property: an airport that
   * leads on every single metric cannot be displaced by reweighting, so the
   * analyzer must report full confidence rather than manufacture doubt.
   */
  it('reports full stability when one airport leads on every metric', () => {
    const { airports, rows } = BuildDominantLeader();
    const analyzer = BuildAnalyzer(airports, rows);
    const result = analyzer.Analyze({ airports, periodId: 'test', overrides: {}, draws: 200 });

    expect(result.distributions[0].probabilityAtBaselineRank).toBe(1);
    expect(result.ties).toHaveLength(0);
  });

  it('handles an empty candidate set without throwing', () => {
    const analyzer = BuildAnalyzer([], []);
    const result = analyzer.Analyze({ airports: [], periodId: 'test', overrides: {}, draws: 10 });

    expect(result.distributions).toHaveLength(0);
    expect(result.isRankingRobust).toBe(false);
    expect(result.narrative).toContain('No airports');
  });

  it('echoes the settings it used, so a figure can be reproduced', () => {
    const { airports, rows } = BuildDominantLeader();
    const analyzer = BuildAnalyzer(airports, rows);
    const result = analyzer.Analyze({ airports, periodId: 'test', overrides: {}, draws: 50, topN: 2, seed: 777 });

    expect(result.draws).toBe(50);
    expect(result.topN).toBe(2);
    expect(result.seed).toBe(777);
    expect(result.weightSpread).toBe(TestConfig.sensitivity.weightSpread);
  });
});
