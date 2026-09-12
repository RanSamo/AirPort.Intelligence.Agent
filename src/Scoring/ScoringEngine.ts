import { AllMetricIds, GetMetricsForPillar, MetricsById } from '../Metrics/MetricRegistry';
import { ScoreBaseline } from './Explain/WaterfallBuilder';
import type { Airport, AirportsByCode, HubClass } from '../Types/Domain/Airport';
import type { AggregatorFactory } from './Aggregators/AggregatorFactory';
import type { AirportScore, AirportScoresByCode } from '../Types/Scoring/Score';
import type { CoverageByPillar, CoverageScore, ExclusionReason } from '../Types/Data/Coverage';
import type { CohortStats } from '../Types/Scoring/Normalization';
import type { CoverageEvaluator } from './Coverage/CoverageEvaluator';
import type { FeasibilityAdjuster } from './Feasibility/FeasibilityAdjuster';
import type { IAirportRepository, IMetricRepository } from '../Types/Ports/Repositories';
import type { MetricId, MetricValuesByMetricAndAirport } from '../Types/Domain/Metric';
import type { MetricWeights, ScoringConfig, ScoringOverrides } from '../Types/Scoring/ScoringConfig';
import type {
  NormalizedByPillar,
  NormalizedMetricValue,
  PreparedAirportsByCode,
} from '../Types/Scoring/Normalization';
import type { PillarCalculator } from './Pillars/PillarCalculator';
import type { PillarScore, PillarScoresById, ScoredPillarId } from '../Types/Scoring/Pillar';
import type { RankRequest, RankResult } from '../Types/Ports/Scoring';
import type { RobustZNormalizer } from './Normalizers/RobustZNormalizer';
import type { ScaleAdjuster } from './Scale/ScaleAdjuster';
import type { WaterfallBuilder } from './Explain/WaterfallBuilder';

/**
 * Deterministic expansion-opportunity scoring.
 *
 * No language model touches any number here. The same inputs and the same
 * config always produce the same score, which is what makes the output
 * auditable and what the brief means by deterministic ranking logic.
 *
 * Airports are normalized WITHIN their FAA hub-class cohort. Comparing Boston
 * to Bradley on a national scale would be meaningless; comparing each against
 * its own peer group is not.
 */

const ScoredPillars: ScoredPillarId[] = ['constraint', 'latent_demand', 'monetization'];

interface CohortStatsIndex {
  [cohortAndMetric: string]: CohortStats;
}

/** Normalized universe, reusable across many differently-weighted scorings. */
export interface PreparedUniverse {
  airports: AirportsByCode;
  prepared: PreparedAirportsByCode;
}

interface ValuesByAirport {
  [iata: string]: { [metricId: string]: number };
}

export class ScoringEngine {
  private readonly airports: IAirportRepository;
  private readonly metrics: IMetricRepository;
  private readonly normalizer: RobustZNormalizer;
  private readonly pillarCalculator: PillarCalculator;
  private readonly coverageEvaluator: CoverageEvaluator;
  private readonly aggregatorFactory: AggregatorFactory;
  private readonly feasibility: FeasibilityAdjuster;
  private readonly scaleAdjuster: ScaleAdjuster;
  private readonly waterfallBuilder: WaterfallBuilder;
  private readonly config: ScoringConfig;

  constructor(
    airports: IAirportRepository,
    metrics: IMetricRepository,
    normalizer: RobustZNormalizer,
    pillarCalculator: PillarCalculator,
    coverageEvaluator: CoverageEvaluator,
    aggregatorFactory: AggregatorFactory,
    feasibility: FeasibilityAdjuster,
    scaleAdjuster: ScaleAdjuster,
    waterfallBuilder: WaterfallBuilder,
    config: ScoringConfig,
  ) {
    this.airports = airports;
    this.metrics = metrics;
    this.normalizer = normalizer;
    this.pillarCalculator = pillarCalculator;
    this.coverageEvaluator = coverageEvaluator;
    this.aggregatorFactory = aggregatorFactory;
    this.feasibility = feasibility;
    this.scaleAdjuster = scaleAdjuster;
    this.waterfallBuilder = waterfallBuilder;
    this.config = config;
  }

  /**
   * Normalizes every airport's metrics within its cohort.
   *
   * Deliberately separate from scoring, because normalization depends only on
   * the cohort and never on the weights. Sensitivity analysis reuses one
   * prepared universe across hundreds of differently-weighted rankings, which
   * turns a ~30-second sweep into a few milliseconds.
   */
  public PrepareUniverse(periodId: string) {
    const allAirports = this.airports.GetAll();
    const byAirport = this.PivotByAirport(this.metrics.GetAllForPeriod(periodId));
    const cohortStats = this.BuildCohortStats(allAirports, byAirport);

    const prepared = Object.keys(byAirport).reduce((accumulator: PreparedAirportsByCode, iata) => {
      const airport = allAirports[iata];
      if (!airport) return accumulator;

      const normalizedByPillar: NormalizedByPillar = {};
      for (const pillarId of ScoredPillars) {
        normalizedByPillar[pillarId] = this.NormalizePillar(
          pillarId,
          airport.hubClass,
          byAirport[iata] ?? {},
          cohortStats,
        );
      }

      accumulator[iata] = { iata, normalizedByPillar };
      return accumulator;
    }, {});

    const universe: PreparedUniverse = { airports: allAirports, prepared };
    return universe;
  }

  /** Applies weights to an already-normalized universe. */
  public ScoreFromPrepared(universe: PreparedUniverse, overrides: ScoringOverrides = {}) {
    const scores = Object.values(universe.prepared).reduce((accumulator: AirportScoresByCode, entry) => {
      const airport = universe.airports[entry.iata];
      if (!airport) return accumulator;

      const score = this.ScoreAirport(airport, entry.normalizedByPillar, overrides);
      if (score) accumulator[entry.iata] = score;
      return accumulator;
    }, {});

    this.AssignCohortPercentiles(scores, universe.airports);
    return scores;
  }

  /**
   * Scores only the requested airports and skips cohort percentiles.
   *
   * The percentile pass has to sort every cohort, which dominates the cost
   * when the same universe is scored hundreds of times. Sensitivity analysis
   * only needs relative ordering within its candidate set, so it uses this
   * path instead — roughly 14x fewer airports scored per draw.
   *
   * Returned scores carry cohortPercentile = 0; do not surface them directly.
   */
  public ScoreSubsetFromPrepared(
    universe: PreparedUniverse,
    codes: string[],
    overrides: ScoringOverrides = {},
  ) {
    return codes.reduce((accumulator: AirportScoresByCode, iata) => {
      const entry = universe.prepared[iata];
      const airport = universe.airports[iata];
      if (!entry || !airport) return accumulator;

      const score = this.ScoreAirport(airport, entry.normalizedByPillar, overrides);
      if (score) accumulator[iata] = score;
      return accumulator;
    }, {});
  }

  /**
   * Scores every airport that has data, so cohort percentiles are computed
   * against the real peer group rather than whatever subset was requested.
   */
  public ScoreUniverse(periodId: string, overrides: ScoringOverrides = {}) {
    return this.ScoreFromPrepared(this.PrepareUniverse(periodId), overrides);
  }

  public ScoreOne(airport: Airport, periodId: string, overrides: ScoringOverrides = {}) {
    const universe = this.ScoreUniverse(periodId, overrides);
    return universe[airport.iata] ?? null;
  }

  public Rank(request: RankRequest) {
    const universe = this.ScoreUniverse(request.periodId, request.overrides);
    const profile = this.ResolveProfile(request.overrides);

    const included: AirportScore[] = [];
    const exclusions: ExclusionReason[] = [];

    for (const airport of request.airports) {
      const score = universe[airport.iata];

      if (!score || score.coverage < this.config.coverage.minimumForRanking) {
        exclusions.push(
          this.coverageEvaluator.BuildExclusion(
            airport,
            score ? this.ExtractCoverage(score.pillars) : {},
            { profileId: profile.id, profileLabel: profile.label },
            this.config,
          ),
        );
        continue;
      }
      included.push(score);
    }

    included.sort((left, right) => right.score - left.score);
    included.forEach((score, index) => {
      score.rank = index + 1;
    });

    const limited = request.topN ? included.slice(0, request.topN) : included;

    const result: RankResult = {
      scores: limited,
      exclusions,
      consideredCount: request.airports.length,
    };
    return result;
  }

  // --- Scoring one airport --------------------------------------------------

  private ScoreAirport(
    airport: Airport,
    normalizedByPillar: NormalizedByPillar,
    overrides: ScoringOverrides,
  ) {
    const profile = this.ResolveProfile(overrides);
    const weights: MetricWeights = { ...profile.metricWeights, ...(overrides.metricWeights ?? {}) };

    const pillars: PillarScoresById = {};
    const coverageByPillar: CoverageByPillar = {};

    for (const pillarId of ScoredPillars) {
      const normalized = normalizedByPillar[pillarId] ?? [];
      const available = normalized.map((entry) => entry.metricId);

      const coverage = this.coverageEvaluator.Evaluate(pillarId, available, weights);
      coverageByPillar[pillarId] = coverage;
      pillars[pillarId] = this.pillarCalculator.Calculate(pillarId, normalized, weights, coverage);
    }

    const constraint = pillars.constraint;
    const latentDemand = pillars.latent_demand;
    const monetization = pillars.monetization;
    if (!constraint || !latentDemand || !monetization) return null;

    // Pillar structure is overridable so sensitivity analysis can perturb it.
    const needComposition = overrides.needComposition ?? profile.needComposition;
    const exponents = overrides.geometricExponents ?? this.config.geometricExponents;

    const need =
      needComposition.constraint * constraint.score + needComposition.latentDemand * latentDemand.score;
    const payoff = monetization.score;

    const aggregator = this.aggregatorFactory.Resolve(overrides.aggregation ?? this.config.aggregation);
    const aggregatedRaw = aggregator.Combine(need, payoff, exponents.need, exponents.payoff);

    const isTerminalProfile = profile.id === 'terminal';
    const { multiplier, reasons } = this.feasibility.Resolve(airport.iata, isTerminalProfile);
    const scale = this.scaleAdjuster.Resolve(airport, overrides.scaleWeighting);
    const finalScore = aggregatedRaw * multiplier * scale.multiplier;

    const coverage = Math.min(
      ...ScoredPillars.map((pillarId) => coverageByPillar[pillarId]?.ratio ?? 0),
    );

    const score: AirportScore = {
      iata: airport.iata,
      airportName: airport.name,
      hubClass: airport.hubClass,
      profile: profile.id,
      aggregation: overrides.aggregation ?? this.config.aggregation,
      score: finalScore,
      need,
      payoff,
      feasibilityMultiplier: multiplier,
      scaleMultiplier: scale.multiplier,
      pillars,
      rank: 0,
      cohortPercentile: 0,
      coverage,
      confidence: this.coverageEvaluator.Evaluate('constraint', [], weights).confidence,
      waterfall: this.waterfallBuilder.Build({
        pillars: { constraint, latentDemand, monetization },
        needConstraintWeight: needComposition.constraint,
        needLatentDemandWeight: needComposition.latentDemand,
        needExponent: exponents.need,
        payoffExponent: exponents.payoff,
        aggregatedRaw,
        feasibilityMultiplier: multiplier,
        feasibilityReasons: reasons,
        scaleMultiplier: scale.multiplier,
        scaleNarrative: scale.narrative,
        finalScore,
      }),
    };

    // Confidence follows the weakest pillar, not an average, so one badly
    // covered pillar cannot be hidden behind two well covered ones.
    score.confidence = this.ResolveConfidence(coverage);
    return score;
  }

  private NormalizePillar(
    pillarId: ScoredPillarId,
    cohort: HubClass,
    rawValues: { [metricId: string]: number },
    cohortStats: CohortStatsIndex,
  ) {
    return GetMetricsForPillar(pillarId).reduce((accumulator: NormalizedMetricValue[], metricId) => {
      const rawValue = rawValues[metricId];
      if (rawValue === undefined) return accumulator;

      const stats = cohortStats[`${cohort}|${metricId}`];
      if (!stats || stats.sampleSize === 0) return accumulator;

      accumulator.push(this.normalizer.Normalize(rawValue, stats, metricId));
      return accumulator;
    }, []);
  }

  // --- Cohorts --------------------------------------------------------------

  /**
   * Builds median/MAD statistics per hub class per metric.
   *
   * Cohort-relative normalization is what makes a Small hub comparable to a
   * Large one: each is measured against airports facing similar economics.
   */
  private BuildCohortStats(allAirports: AirportsByCode, byAirport: ValuesByAirport) {
    const grouped = Object.entries(byAirport).reduce((accumulator: CohortValueIndex, [iata, values]) => {
      const airport = allAirports[iata];
      if (!airport) return accumulator;

      for (const metricId of AllMetricIds) {
        const value = values[metricId];
        if (value === undefined) continue;

        const key = `${airport.hubClass}|${metricId}`;
        const existing = accumulator[key];
        if (existing) existing.push(value);
        else accumulator[key] = [value];
      }
      return accumulator;
    }, {});

    return Object.entries(grouped).reduce((accumulator: CohortStatsIndex, [key, values]) => {
      const metricId = key.split('|')[1] as MetricId;
      const cohort = key.split('|')[0] as HubClass;
      accumulator[key] = this.normalizer.BuildCohortStats(values, metricId, cohort);
      return accumulator;
    }, {});
  }

  private AssignCohortPercentiles(scores: AirportScoresByCode, allAirports: AirportsByCode) {
    const byCohort = Object.values(scores).reduce((accumulator: CohortScoreIndex, score) => {
      const airport = allAirports[score.iata];
      if (!airport) return accumulator;
      const existing = accumulator[airport.hubClass];
      if (existing) existing.push(score.score);
      else accumulator[airport.hubClass] = [score.score];
      return accumulator;
    }, {});

    for (const cohort of Object.keys(byCohort)) {
      byCohort[cohort].sort((left, right) => left - right);
    }

    for (const score of Object.values(scores)) {
      const peers = byCohort[score.hubClass] ?? [];
      if (peers.length === 0) continue;
      const below = peers.filter((value) => value < score.score).length;
      score.cohortPercentile = (below / peers.length) * 100;
    }
  }

  // --- Helpers --------------------------------------------------------------

  private ResolveProfile(overrides: ScoringOverrides) {
    const profileId = overrides.profile ?? this.config.defaultProfile;
    const profile = this.config.profiles[profileId];
    if (!profile) throw new Error(`Unknown score profile: "${profileId}"`);
    return profile;
  }

  private ExtractCoverage(pillars: PillarScoresById) {
    return Object.entries(pillars).reduce((accumulator: CoverageByPillar, [pillarId, pillar]) => {
      accumulator[pillarId] = pillar.coverage;
      return accumulator;
    }, {});
  }

  private ResolveConfidence(coverage: number): CoverageScore['confidence'] {
    if (coverage >= 0.85) return 'high';
    if (coverage >= this.config.coverage.lowConfidenceThreshold) return 'medium';
    return 'low';
  }

  private PivotByAirport(values: MetricValuesByMetricAndAirport) {
    return Object.entries(values).reduce((accumulator: ValuesByAirport, [metricId, byCode]) => {
      for (const [iata, value] of Object.entries(byCode)) {
        const existing = accumulator[iata];
        if (existing) existing[metricId] = value;
        else accumulator[iata] = { [metricId]: value };
      }
      return accumulator;
    }, {});
  }
}

interface CohortValueIndex {
  [cohortAndMetric: string]: number[];
}

interface CohortScoreIndex {
  [cohort: string]: number[];
}

/** Re-exported so callers can reference the baseline without reaching into the builder. */
export { ScoreBaseline, MetricsById };
