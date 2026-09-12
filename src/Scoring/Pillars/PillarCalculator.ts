import { GetMetric } from '../../Metrics/MetricRegistry';
import type { CoverageScore } from '../../Types/Data/Coverage';
import type { IPillarCalculator } from '../../Types/Ports/Scoring';
import type { MetricContribution, PillarScore, ScoredPillarId } from '../../Types/Scoring/Pillar';
import type { MetricWeights } from '../../Types/Scoring/ScoringConfig';
import type { NormalizedMetricValue } from '../../Types/Scoring/Normalization';

/**
 * Reduces a pillar's normalized metrics to a single 0-100 subscore.
 *
 * Weights are renormalized over the metrics that are actually present, which
 * is the whole missing-data policy in one line: an absent metric contributes
 * nothing and is never imputed, but it also does not drag the pillar toward
 * zero. The cost of the gap shows up as reduced coverage and confidence
 * instead, where the user can see it.
 *
 * Every per-metric contribution is retained so the score can be explained
 * term by term rather than asserted.
 */
export class PillarCalculator implements IPillarCalculator {
  public Calculate(
    pillarId: ScoredPillarId,
    normalizedValues: NormalizedMetricValue[],
    weights: MetricWeights,
    coverage: CoverageScore,
  ) {
    const weighted = normalizedValues.reduce((accumulator: WeightedTotals, normalized) => {
      const weight = weights[normalized.metricId] ?? GetMetric(normalized.metricId).weight;
      if (weight <= 0) return accumulator;

      accumulator.totalWeight += weight;
      accumulator.entries.push({ normalized, weight });
      return accumulator;
    }, { totalWeight: 0, entries: [] });

    // No usable metric for this pillar. The cohort midpoint is the only
    // defensible value: it neither rewards nor punishes an airport for a gap
    // in the data, and the coverage figure records that we are guessing
    // nothing here.
    if (weighted.totalWeight === 0) {
      const empty: PillarScore = { pillarId, score: 50, coverage, contributions: [] };
      return empty;
    }

    const contributions = weighted.entries.map((entry) => {
      const effectiveWeight = entry.weight / weighted.totalWeight;
      const contribution: MetricContribution = {
        metricId: entry.normalized.metricId,
        rawValue: entry.normalized.rawValue,
        normalizedScore: entry.normalized.normalizedScore,
        effectiveWeight,
        contribution: effectiveWeight * entry.normalized.normalizedScore,
      };
      return contribution;
    });

    const score = contributions.reduce((sum, contribution) => sum + contribution.contribution, 0);

    const result: PillarScore = {
      pillarId,
      score,
      coverage,
      contributions,
    };
    return result;
  }
}

interface WeightedEntry {
  normalized: NormalizedMetricValue;
  weight: number;
}

interface WeightedTotals {
  totalWeight: number;
  entries: WeightedEntry[];
}
