import type { HubClass, IataCode } from '../Domain/Airport';
import type { ConfidenceLevel } from '../Data/Coverage';
import type { PillarScoresById } from './Pillar';
import type { AggregationMode, ScoreProfileId } from './ScoringConfig';

/**
 * One row of the score explanation.
 *
 * Terms are constructed as weight * (subscore - baseline), so the waterfall
 * sums EXACTLY to the final score. This is a real additive attribution, not
 * an approximation of one — there is nothing to reconcile.
 */
export type WaterfallTermKind = 'baseline' | 'pillar' | 'feasibility' | 'scale';

export interface WaterfallTerm {
  kind: WaterfallTermKind;
  label: string;
  /** Signed contribution in score points. */
  amount: number;
  /** Running total after applying this term. */
  runningTotal: number;
  /** Plain-language reason, e.g. "taxi-out is 6.2 min above the Large-hub median". */
  narrative: string;
}

export interface ScoreWaterfall {
  /** Cohort baseline, normally 50 — the median airport in the peer group. */
  baseline: number;
  terms: WaterfallTerm[];
  total: number;
}

export interface AirportScore {
  iata: IataCode;
  airportName: string;
  hubClass: HubClass;
  profile: ScoreProfileId;
  aggregation: AggregationMode;

  /** Final 0-100 expansion opportunity score. */
  score: number;
  /** Constraint + LatentDemand, blended by needComposition. */
  need: number;
  /** Monetization. */
  payoff: number;
  /** Multiplier in roughly 0.5-1.05 applied after the Need/Payoff blend. */
  feasibilityMultiplier: number;
  /**
   * Materiality multiplier from absolute passenger volume, log-scaled.
   * Counteracts cohort-relative normalization, which otherwise lets a
   * best-in-class small airport outrank a very good mega-hub.
   */
  scaleMultiplier: number;

  pillars: PillarScoresById;

  /** Rank within the requested result set. */
  rank: number;
  /** Percentile within the airport's own FAA hub-class cohort, 0-100. */
  cohortPercentile: number;

  /** Minimum pillar coverage across the scored pillars. */
  coverage: number;
  confidence: ConfidenceLevel;

  waterfall: ScoreWaterfall;
}

export interface AirportScoresByCode {
  [iataCode: string]: AirportScore;
}
