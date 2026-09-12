import { GetMetric } from '../../Metrics/MetricRegistry';
import type { PillarScore, ScoredPillarId } from '../../Types/Scoring/Pillar';
import type { ScoreWaterfall, WaterfallTerm } from '../../Types/Scoring/Score';

/**
 * Builds an exactly-additive explanation of a score.
 *
 * Every term is weight * (subscore - baseline), so the terms sum to the final
 * score by construction. There is nothing to reconcile and no approximation:
 * this is a real attribution, not an estimate of one.
 *
 * Geometric aggregation is not linear, so a purely additive decomposition
 * cannot reproduce it on its own. Rather than hide that, the difference is
 * surfaced as its own explicit term. That makes the effect of the geometric
 * blend *visible* — the user can see exactly how many points an airport lost
 * for being unbalanced across pillars, which is the whole reason the
 * geometric mode exists.
 */

/** The cohort midpoint. A perfectly median airport scores here. */
export const ScoreBaseline = 50;

export interface WaterfallInputs {
  pillars: PillarScoresInput;
  needConstraintWeight: number;
  needLatentDemandWeight: number;
  needExponent: number;
  payoffExponent: number;
  /** Output of the aggregator, before feasibility and scale. */
  aggregatedRaw: number;
  feasibilityMultiplier: number;
  feasibilityReasons: string[];
  scaleMultiplier: number;
  scaleNarrative: string;
  finalScore: number;
}

export interface PillarScoresInput {
  constraint: PillarScore | null;
  latentDemand: PillarScore | null;
  monetization: PillarScore | null;
}

export class WaterfallBuilder {
  public Build(inputs: WaterfallInputs) {
    const terms: WaterfallTerm[] = [];
    let running = ScoreBaseline;

    const push = (kind: WaterfallTerm['kind'], label: string, amount: number, narrative: string) => {
      running += amount;
      terms.push({ kind, label, amount, runningTotal: running, narrative });
    };

    terms.push({
      kind: 'baseline',
      label: 'Peer-group median',
      amount: ScoreBaseline,
      runningTotal: ScoreBaseline,
      narrative: 'Every airport starts at the midpoint of its FAA hub-class cohort.',
    });

    const constraintWeight = inputs.needExponent * inputs.needConstraintWeight;
    const latentWeight = inputs.needExponent * inputs.needLatentDemandWeight;

    this.PushPillar(push, 'Capacity pressure', inputs.pillars.constraint, constraintWeight, 'constraint');
    this.PushPillar(push, 'Demand growth', inputs.pillars.latentDemand, latentWeight, 'latent_demand');
    this.PushPillar(push, 'Revenue quality', inputs.pillars.monetization, inputs.payoffExponent, 'monetization');

    // Reconciles the linear decomposition above with the actual aggregator.
    const aggregationAdjustment = inputs.aggregatedRaw - running;
    if (Math.abs(aggregationAdjustment) > 0.005) {
      push(
        'pillar',
        'Balance across pillars',
        aggregationAdjustment,
        aggregationAdjustment < 0
          ? 'Penalised for being uneven across pillars: the geometric blend requires both a binding constraint and something worth monetising, so a strong pillar cannot compensate for a weak one.'
          : 'Rewarded for being well balanced across pillars under the geometric blend.',
      );
    }

    // Feasibility and scale are both multiplicative, so each term is the
    // points that multiplier actually moved the running total. They still
    // sum exactly, because each is measured against the value before it.
    const afterFeasibility = inputs.aggregatedRaw * inputs.feasibilityMultiplier;
    const feasibilityAmount = afterFeasibility - inputs.aggregatedRaw;

    if (Math.abs(feasibilityAmount) > 0.005) {
      push(
        'feasibility',
        `Feasibility (x${inputs.feasibilityMultiplier.toFixed(2)})`,
        feasibilityAmount,
        inputs.feasibilityReasons.length > 0
          ? `Adjusted because the airport is ${inputs.feasibilityReasons.join('; ')}.`
          : 'No structural constraints recorded.',
      );
    }

    const scaleAmount = inputs.finalScore - afterFeasibility;
    if (Math.abs(scaleAmount) > 0.005) {
      push('scale', `Materiality (x${inputs.scaleMultiplier.toFixed(2)})`, scaleAmount, inputs.scaleNarrative);
    }

    const waterfall: ScoreWaterfall = {
      baseline: ScoreBaseline,
      terms,
      total: running,
    };
    return waterfall;
  }

  private PushPillar(
    push: (kind: WaterfallTerm['kind'], label: string, amount: number, narrative: string) => void,
    label: string,
    pillar: PillarScore | null,
    weight: number,
    pillarId: ScoredPillarId,
  ) {
    if (!pillar) return;

    const amount = weight * (pillar.score - ScoreBaseline);
    push('pillar', label, amount, this.DescribePillar(pillar, pillarId));
  }

  /** Names the two metrics that moved this pillar furthest from the median. */
  private DescribePillar(pillar: PillarScore, pillarId: ScoredPillarId) {
    if (pillar.contributions.length === 0) {
      return `No usable ${pillarId.replace('_', ' ')} data, so this pillar sits at the cohort midpoint.`;
    }

    const ranked = [...pillar.contributions].sort(
      (left, right) =>
        Math.abs(right.normalizedScore - ScoreBaseline) - Math.abs(left.normalizedScore - ScoreBaseline),
    );

    const described = ranked.slice(0, 2).map((contribution) => {
      const definition = GetMetric(contribution.metricId);
      const direction = contribution.normalizedScore >= ScoreBaseline ? 'above' : 'below';
      return `${definition.label.toLowerCase()} well ${direction} the cohort median`;
    });

    const coverageNote =
      pillar.coverage.ratio < 1
        ? ` Based on ${pillar.contributions.length} of ${
            pillar.contributions.length + pillar.coverage.missingMetrics.length
          } inputs.`
        : '';

    return `Driven by ${described.join(' and ')}.${coverageNote}`;
  }
}
