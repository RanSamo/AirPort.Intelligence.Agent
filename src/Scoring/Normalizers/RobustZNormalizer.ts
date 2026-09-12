import { GetMetric } from '../../Metrics/MetricRegistry';
import type { CohortStats, NormalizedMetricValue } from '../../Types/Scoring/Normalization';
import type { HubClass } from '../../Types/Domain/Airport';
import type { INormalizer } from '../../Types/Ports/Scoring';
import type { MetricId } from '../../Types/Domain/Metric';
import type { ScoringConfig } from '../../Types/Scoring/ScoringConfig';

/**
 * Turns incomparable raw units (minutes, ratios, dollars) into comparable
 * 0-100 subscores.
 *
 * Pipeline, per metric, within a peer cohort:
 *   1. winsorize at p5/p95      stop a couple of extreme airports dominating
 *   2. robust z-score           (x - median) / (1.4826 * MAD)
 *   3. logistic squash          to a bounded 0-100
 *   4. flip sign                if the metric reads lower_is_better
 *
 * Median/MAD rather than mean/stdev because aviation metrics are heavily
 * right-skewed: a handful of mega-hubs would drag the mean and compress
 * everyone else into a narrow band.
 *
 * Logistic rather than min-max because min-max is not stable — adding one
 * new extreme airport silently rescales every existing score, so yesterday's
 * ranking would not reproduce today.
 */
export class RobustZNormalizer implements INormalizer {
  /** Consistency constant making MAD comparable to a standard deviation under normality. */
  private static readonly MadScale = 1.4826;

  private readonly config: ScoringConfig;

  constructor(config: ScoringConfig) {
    this.config = config;
  }

  public BuildCohortStats(values: number[], metricId: MetricId, cohort: HubClass | 'national') {
    const finite = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);

    if (finite.length === 0) {
      const empty: CohortStats = {
        metricId,
        cohort,
        median: 0,
        scaledMad: 0,
        winsorLowerBound: 0,
        winsorUpperBound: 0,
        sampleSize: 0,
      };
      return empty;
    }

    const median = this.Percentile(finite, 0.5);
    const deviations = finite.map((value) => Math.abs(value - median)).sort((left, right) => left - right);
    const medianAbsoluteDeviation = this.Percentile(deviations, 0.5);

    const stats: CohortStats = {
      metricId,
      cohort,
      median,
      scaledMad: medianAbsoluteDeviation * RobustZNormalizer.MadScale,
      winsorLowerBound: this.Percentile(finite, this.config.normalization.winsorLowerPercentile),
      winsorUpperBound: this.Percentile(finite, this.config.normalization.winsorUpperPercentile),
      sampleSize: finite.length,
    };
    return stats;
  }

  public Normalize(rawValue: number, stats: CohortStats, metricId: MetricId) {
    const definition = GetMetric(metricId);

    const winsorized = Math.min(Math.max(rawValue, stats.winsorLowerBound), stats.winsorUpperBound);

    // A zero MAD means every airport in the cohort reported the same value,
    // so the metric carries no discriminating information here. Scoring it
    // at the cohort midpoint is the honest outcome — not an error, and not
    // an arbitrary win for whoever happens to be listed first.
    const robustZ = stats.scaledMad > 0 ? (winsorized - stats.median) / stats.scaledMad : 0;

    const directedZ = definition.direction === 'lower_is_better' ? -robustZ : robustZ;
    const squashed = 100 / (1 + Math.exp(-this.config.normalization.logisticSteepness * directedZ));

    const normalized: NormalizedMetricValue = {
      metricId,
      rawValue,
      winsorizedValue: winsorized,
      robustZ: directedZ,
      normalizedScore: Math.max(this.config.normalization.subscoreFloor, squashed),
    };
    return normalized;
  }

  /** Linear-interpolated percentile over a pre-sorted ascending array. */
  private Percentile(sorted: number[], percentile: number) {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];

    const position = (sorted.length - 1) * percentile;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);

    if (lowerIndex === upperIndex) return sorted[lowerIndex];

    const weight = position - lowerIndex;
    return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
  }
}
