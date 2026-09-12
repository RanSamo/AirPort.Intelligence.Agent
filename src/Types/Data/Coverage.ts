import type { IataCode } from '../Domain/Airport';
import type { MetricId } from '../Domain/Metric';
import type { PillarId } from '../Scoring/Pillar';

/**
 * Coverage and exclusions.
 *
 * Coverage is a first-class, disclosed dimension of every result. The system
 * ingests every US airport the public APIs provide, which means coverage
 * varies enormously: ~350 airports report On-Time Performance, ~1,220 report
 * T-100, and only the hand-curated subset has gate counts.
 *
 * We never impute a missing value. Instead the pillar reweights over what is
 * available, coverage drops, and the user is told.
 */

export type ConfidenceLevel = 'high' | 'medium' | 'low';

/**
 * Coverage over a set of weighted metrics:
 *   available weight / total weight, in 0-1.
 */
export interface CoverageScore {
  ratio: number;
  availableMetrics: MetricId[];
  missingMetrics: MetricId[];
  confidence: ConfidenceLevel;
}

export interface CoverageByPillar {
  [pillarId: string]: CoverageScore;
}

/**
 * Why a specific airport was left out of a ranking.
 *
 * Deliberately specific: a bare "insufficient data" invites exactly the
 * question it should answer. The reason names the missing metric and why it
 * mattered *for the question that was asked* — a congestion comparison
 * excludes airports for missing OTP data, not for missing gate counts.
 */
export type ExclusionCode =
  /** Airport is not in BTS On-Time Performance, so no congestion metrics exist. */
  | 'not_otp_reporting'
  /** Has some data, but below the minimum coverage threshold for a fair ranking. */
  | 'below_coverage_threshold'
  /** No T-100 passenger record in the requested period. */
  | 'no_traffic_data';

/**
 * What the user actually asked for. Carried into exclusion building so the
 * reason can explain why a gap mattered *for this question* — a congestion
 * comparison excludes airports for missing on-time data, not for missing
 * gate counts.
 */
export interface ExclusionContext {
  profileId: string;
  profileLabel: string;
}

export interface ExclusionReason {
  iata: IataCode;
  airportName: string;
  code: ExclusionCode;
  missingMetrics: MetricId[];
  affectedPillar: PillarId | null;
  coverage: number;
  requiredCoverage: number;
  /** Question-aware sentence the agent renders verbatim to the user. */
  explanation: string;
}

export interface ExclusionReasonsByCode {
  [iataCode: string]: ExclusionReason;
}
