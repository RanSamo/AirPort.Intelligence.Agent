import type { HubClass } from '../Domain/Airport';
import type { MetricId } from '../Domain/Metric';

/**
 * Normalization turns incomparable raw units (minutes, ratios, dollars) into
 * comparable 0-100 subscores.
 *
 * Pipeline, per metric, within a peer cohort:
 *   1. winsorize at p5/p95            kill outlier domination
 *   2. robust z = (x - median) / (1.4826 * MAD)
 *   3. logistic squash to 0-100
 *   4. flip sign if lower_is_better
 *
 * Median/MAD rather than mean/stdev because aviation metrics are heavily
 * skewed — a handful of mega-hubs would otherwise drag the mean and compress
 * everyone else. Logistic rather than min-max because min-max lets a single
 * new airport rescale every existing score.
 */

export interface CohortStats {
  metricId: MetricId;
  cohort: HubClass | 'national';
  median: number;
  /** Median absolute deviation, already scaled by 1.4826 for normal consistency. */
  scaledMad: number;
  winsorLowerBound: number;
  winsorUpperBound: number;
  sampleSize: number;
}

export interface CohortStatsByMetric {
  [metricId: string]: CohortStats;
}

/** Cohort key -> metric id -> stats. */
export interface CohortStatsByCohortAndMetric {
  [cohort: string]: CohortStatsByMetric;
}

export interface NormalizedMetricValue {
  metricId: MetricId;
  rawValue: number;
  winsorizedValue: number;
  robustZ: number;
  /** 0-100 after the logistic squash and direction flip. */
  normalizedScore: number;
}

export interface NormalizedValuesByMetric {
  [metricId: string]: NormalizedMetricValue;
}

export interface NormalizedByPillar {
  [pillarId: string]: NormalizedMetricValue[];
}

/**
 * An airport with its metrics already normalized.
 *
 * Normalization depends only on the cohort, never on the weights, so it can
 * be computed once and reused across many differently-weighted scorings.
 * That is what makes sensitivity analysis cheap enough to run inside a chat
 * response: the expensive step happens once, and only the weighted sum is
 * repeated.
 */
export interface PreparedAirport {
  iata: string;
  normalizedByPillar: NormalizedByPillar;
}

export interface PreparedAirportsByCode {
  [iataCode: string]: PreparedAirport;
}
