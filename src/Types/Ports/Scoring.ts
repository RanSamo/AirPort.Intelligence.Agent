import type { Airport, HubClass, IataCode } from '../Domain/Airport';
import type { MetricId } from '../Domain/Metric';
import type { CoverageByPillar, CoverageScore, ExclusionContext, ExclusionReason } from '../Data/Coverage';
import type { CohortStats, NormalizedMetricValue } from '../Scoring/Normalization';
import type { PillarScore, ScoredPillarId } from '../Scoring/Pillar';
import type { AirportScore, ScoreWaterfall } from '../Scoring/Score';
import type { MetricWeights, ScoringConfig, ScoringOverrides } from '../Scoring/ScoringConfig';
import type { SensitivityResult } from '../Scoring/Sensitivity';
import type { UnmetDemandAssessment } from '../Scoring/Spill';

export interface INormalizer {
  BuildCohortStats(values: number[], metricId: MetricId, cohort: HubClass | 'national'): CohortStats;
  Normalize(rawValue: number, stats: CohortStats, metricId: MetricId): NormalizedMetricValue;
}

/**
 * Combines Need and Payoff into the pre-feasibility score.
 * Implemented as an injected strategy so the geometric/arithmetic choice is
 * a config value rather than a branch buried inside the maths.
 */
export interface IAggregator {
  readonly mode: string;
  Combine(need: number, payoff: number, needExponent: number, payoffExponent: number): number;
}

export interface IPillarCalculator {
  /** Weights are renormalized over the metrics actually present; nothing is imputed. */
  Calculate(
    pillarId: ScoredPillarId,
    normalizedValues: NormalizedMetricValue[],
    weights: MetricWeights,
    coverage: CoverageScore,
  ): PillarScore;
}

export interface IFeasibilityAdjuster {
  /** Returns a multiplier in roughly 0.5-1.05. */
  Resolve(iata: IataCode, isTerminalProfile: boolean): { multiplier: number; reasons: string[] };
}

export interface IWaterfallBuilder {
  Build(score: AirportScore, baseline: number): ScoreWaterfall;
}

export interface ICoverageEvaluator {
  /** Weighted share of a pillar's metrics that are actually available for this airport. */
  Evaluate(pillarId: ScoredPillarId, availableMetrics: MetricId[], weights: MetricWeights): CoverageScore;
  /**
   * Builds a specific, question-aware reason an airport was left out.
   * Never a bare "insufficient data": the reason names the missing metric
   * and why it mattered for the profile that was requested.
   */
  BuildExclusion(
    airport: Airport,
    coverageByPillar: CoverageByPillar,
    context: ExclusionContext,
    config: ScoringConfig,
  ): ExclusionReason;
}

export interface RankRequest {
  airports: Airport[];
  periodId: string;
  overrides: ScoringOverrides;
  topN?: number;
}

export interface RankResult {
  scores: AirportScore[];
  exclusions: ExclusionReason[];
  /** Airports considered before the minimum-coverage filter was applied. */
  consideredCount: number;
}

export interface IScoringEngine {
  ScoreOne(airport: Airport, periodId: string, overrides: ScoringOverrides): AirportScore | null;
  Rank(request: RankRequest): RankResult;
  AnalyzeSensitivity(request: RankRequest, draws: number, topN: number): SensitivityResult;
}

export interface ISpillModel {
  Assess(iata: IataCode, from: string, to: string): UnmetDemandAssessment | null;
}
