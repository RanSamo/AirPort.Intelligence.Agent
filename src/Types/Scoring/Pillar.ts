import type { MetricId } from '../Domain/Metric';
import type { CoverageScore } from '../Data/Coverage';

/**
 * The four pillars encode the investment thesis:
 *
 *   You make money relieving a BINDING CONSTRAINT on demand that ALREADY
 *   EXISTS AND IS GROWING, at an airport where a marginal passenger is
 *   HIGH-YIELD, and where nothing structural blocks REALIZATION.
 *
 * Constraint + LatentDemand combine into "Need"; Monetization is "Payoff";
 * Feasibility is a multiplier rather than a weighted adder, because it gates
 * the whole thesis instead of contributing to it.
 */
export type PillarId = 'constraint' | 'latent_demand' | 'monetization' | 'feasibility';

/** Scoring pillars that contribute a 0-100 subscore. Feasibility is excluded: it multiplies. */
export type ScoredPillarId = Extract<PillarId, 'constraint' | 'latent_demand' | 'monetization'>;

export interface PillarDefinition {
  id: PillarId;
  label: string;
  description: string;
  metrics: MetricId[];
}

export interface PillarDefinitionsById {
  [pillarId: string]: PillarDefinition;
}

/** Per-metric contribution inside a pillar, retained so a score can be explained. */
export interface MetricContribution {
  metricId: MetricId;
  rawValue: number;
  normalizedScore: number;
  /** Weight after renormalizing over available metrics only. */
  effectiveWeight: number;
  contribution: number;
}

export interface PillarScore {
  pillarId: ScoredPillarId;
  /** 0-100. */
  score: number;
  coverage: CoverageScore;
  contributions: MetricContribution[];
}

export interface PillarScoresById {
  [pillarId: string]: PillarScore;
}
