import { GetMetric, GetMetricsForPillar } from '../../Metrics/MetricRegistry';
import type { Airport } from '../../Types/Domain/Airport';
import type {
  ConfidenceLevel,
  CoverageByPillar,
  CoverageScore,
  ExclusionCode,
  ExclusionContext,
  ExclusionReason,
} from '../../Types/Data/Coverage';
import type { ICoverageEvaluator } from '../../Types/Ports/Scoring';
import type { MetricId } from '../../Types/Domain/Metric';
import type { MetricWeights, ScoringConfig } from '../../Types/Scoring/ScoringConfig';
import type { ScoredPillarId } from '../../Types/Scoring/Pillar';

/**
 * Decides how much of a pillar we actually know, and explains what is missing.
 *
 * The system ingests every US airport the public data covers, so coverage
 * varies enormously — roughly 350 airports report on-time performance out of
 * ~1,090, and only a curated subset has gate counts. Rather than impute
 * anything, weights are renormalized over whatever is present and the gap is
 * reported.
 *
 * The exclusion text is deliberately specific. "Insufficient data" invites
 * exactly the question it should have answered, so a reason names the metric
 * that is missing and why it mattered for the profile that was requested.
 */

const PillarLabels: PillarLabelsById = {
  constraint: 'capacity pressure',
  latent_demand: 'demand growth',
  monetization: 'revenue quality',
};

interface PillarLabelsById {
  [pillarId: string]: string;
}

export class CoverageEvaluator implements ICoverageEvaluator {
  private readonly config: ScoringConfig;

  constructor(config: ScoringConfig) {
    this.config = config;
  }

  public Evaluate(pillarId: ScoredPillarId, availableMetrics: MetricId[], weights: MetricWeights) {
    const available = availableMetrics.reduce((accumulator: AvailabilitySet, metricId) => {
      accumulator[metricId] = true;
      return accumulator;
    }, {});

    const pillarMetrics = GetMetricsForPillar(pillarId);

    const totals = pillarMetrics.reduce(
      (accumulator: WeightTotals, metricId) => {
        const weight = weights[metricId] ?? GetMetric(metricId).weight;
        accumulator.total += weight;
        if (available[metricId]) {
          accumulator.availableWeight += weight;
          accumulator.availableMetrics.push(metricId);
        } else {
          accumulator.missingMetrics.push(metricId);
        }
        return accumulator;
      },
      { total: 0, availableWeight: 0, availableMetrics: [], missingMetrics: [] },
    );

    const ratio = totals.total > 0 ? totals.availableWeight / totals.total : 0;

    const score: CoverageScore = {
      ratio,
      availableMetrics: totals.availableMetrics,
      missingMetrics: totals.missingMetrics,
      confidence: this.ResolveConfidence(ratio),
    };
    return score;
  }

  public BuildExclusion(
    airport: Airport,
    coverageByPillar: CoverageByPillar,
    context: ExclusionContext,
    config: ScoringConfig,
  ) {
    const weakest = this.FindWeakestPillar(coverageByPillar);
    const missingMetrics = weakest ? weakest.coverage.missingMetrics : [];
    const code = this.ResolveCode(airport);

    const reason: ExclusionReason = {
      iata: airport.iata,
      airportName: airport.name,
      code,
      missingMetrics,
      affectedPillar: weakest ? weakest.pillarId : null,
      coverage: weakest ? weakest.coverage.ratio : 0,
      requiredCoverage: config.coverage.minimumForRanking,
      explanation: this.BuildExplanation(airport, code, missingMetrics, weakest?.pillarId ?? null, context),
    };
    return reason;
  }

  private ResolveCode(airport: Airport): ExclusionCode {
    if (!airport.reportsOnTimePerformance) return 'not_otp_reporting';
    if (airport.annualEnplanements <= 0) return 'no_traffic_data';
    return 'below_coverage_threshold';
  }

  /**
   * One sentence the agent can render verbatim. It has to answer "why is my
   * airport not in this list?" without the user needing to ask a follow-up.
   */
  private BuildExplanation(
    airport: Airport,
    code: ExclusionCode,
    missingMetrics: MetricId[],
    pillarId: ScoredPillarId | null,
    context: ExclusionContext,
  ) {
    const pillarLabel = pillarId ? PillarLabels[pillarId] ?? pillarId : 'the scoring model';

    if (code === 'not_otp_reporting') {
      return (
        `${airport.name} (${airport.iata}) is not covered by BTS On-Time Performance reporting, which only ` +
        `includes carriers above 0.5% of US domestic revenue. Without it there are no delay, taxi-time or ` +
        `peak-hour figures, so its ${pillarLabel} cannot be assessed for a ${context.profileLabel.toLowerCase()} ` +
        `comparison. Passenger and capacity data is still available if you want to look at it on its own.`
      );
    }

    if (code === 'no_traffic_data') {
      return (
        `${airport.name} (${airport.iata}) has no reported passenger traffic in this period, so there is ` +
        `nothing to base a ${context.profileLabel.toLowerCase()} assessment on.`
      );
    }

    const missingLabels = missingMetrics.slice(0, 3).map((metricId) => GetMetric(metricId).label.toLowerCase());
    const listed = missingLabels.length > 0 ? missingLabels.join(', ') : 'several inputs';

    return (
      `${airport.name} (${airport.iata}) is missing too much of the ${pillarLabel} evidence to rank fairly ` +
      `against the others — no ${listed}. Ranking it on what little is available would overstate how much ` +
      `we actually know about it.`
    );
  }

  private FindWeakestPillar(coverageByPillar: CoverageByPillar) {
    return Object.entries(coverageByPillar).reduce((weakest: WeakestPillar | null, [pillarId, coverage]) => {
      if (!weakest || coverage.ratio < weakest.coverage.ratio) {
        return { pillarId: pillarId as ScoredPillarId, coverage };
      }
      return weakest;
    }, null);
  }

  private ResolveConfidence(ratio: number): ConfidenceLevel {
    if (ratio >= 0.85) return 'high';
    if (ratio >= this.config.coverage.lowConfidenceThreshold) return 'medium';
    return 'low';
  }
}

interface AvailabilitySet {
  [metricId: string]: true;
}

interface WeightTotals {
  total: number;
  availableWeight: number;
  availableMetrics: MetricId[];
  missingMetrics: MetricId[];
}

interface WeakestPillar {
  pillarId: ScoredPillarId;
  coverage: CoverageScore;
}
