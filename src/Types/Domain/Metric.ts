import type { DataSourceId } from '../Data/Source';
import type { PillarId } from '../Scoring/Pillar';

/**
 * The complete metric vocabulary. Declared as a literal union so that a typo
 * anywhere in the scoring config, a calculator, or a tool is a compile error
 * rather than a silently missing metric.
 */
export type MetricId =
  // --- Constraint: is capacity binding today? -----------------------------
  | 'taxi_out_p50'
  | 'taxi_out_p90'
  | 'dep_delay_15_rate'
  | 'nas_delay_share'
  | 'peak_hour_passengers'
  | 'seats_per_departure_trend'
  // --- Latent demand: would new capacity get filled? ----------------------
  | 'enplanement_cagr_3y'
  | 'seat_cagr_3y'
  | 'avg_load_factor'
  | 'pct_months_lf_gt_85'
  | 'spill_rate'
  // --- Monetization: is a marginal passenger high-yield? ------------------
  | 'intl_pax_share'
  | 'long_haul_share'
  | 'avg_passenger_trip_miles';

/*
 * METRICS DELIBERATELY NOT INCLUDED — every one lacked a working data source,
 * and under the project's no-guessing rule a metric that is permanently
 * absent is worse than no metric at all: it drags coverage down and generates
 * exclusion text for every airport without adding any signal.
 *
 *   pax_per_gate      no public API publishes gate counts, anywhere. Verified
 *                     against FAA 5010/ADIP/NPIAS and Wikidata (which has no
 *                     gate property at all). peak_hour_passengers measures the
 *                     thing gates are a proxy for, and needs no curation.
 *   peak_hour_util    needs a curated hourly capacity figure; FAA FACT3 covers
 *                     only ~48 airports. taxi_out_p90 and nas_delay_share
 *                     measure saturation directly rather than by proxy.
 *   catchment_growth  |
 *   catchment_income  |  all three need Census data plus an airport-to-metro
 *   epc_gap           |  crosswalk that has no clean public source. Building
 *                     one properly is hours of work for one soft signal, and
 *                     a sloppy one would violate the no-guessing rule.
 *
 * The catchment/demographic dimension is a stated limitation in DESIGN.md.
 */

/**
 * Whether a larger raw value indicates a stronger investment case. Applied
 * during normalization by flipping the sign of the z-score.
 *
 * Note these are read from the *investment opportunity* angle, not the
 * passenger's: long taxi-out times are bad for travellers but indicate a
 * binding airfield constraint, which is exactly what we are hunting.
 */
export type MetricDirection = 'higher_is_better' | 'lower_is_better';

export type MetricUnit =
  | 'minutes'
  | 'ratio'
  | 'percent'
  | 'count'
  | 'usd'
  | 'passengers'
  | 'index';

/**
 * How a value came to exist. The agent is required to distinguish these in
 * its answers: a measured BTS figure and a modeled spill estimate must never
 * be presented with the same confidence.
 */
export type MetricProvenance = 'measured' | 'modeled' | 'curated';

export interface MetricDefinition {
  id: MetricId;
  pillar: PillarId;
  label: string;
  /** Shown to the user when explaining a score. Plain language, no jargon. */
  description: string;
  unit: MetricUnit;
  direction: MetricDirection;
  provenance: MetricProvenance;
  source: DataSourceId;
  /** Relative weight inside its pillar. Weights are renormalized over whatever is available. */
  weight: number;
}

export interface MetricDefinitionsById {
  [metricId: string]: MetricDefinition;
}

/** A single computed metric value for one airport over one analysis period. */
export interface MetricValue {
  metricId: MetricId;
  iata: string;
  periodId: string;
  value: number;
  /** Number of underlying observations. Low counts justify low confidence. */
  sampleSize: number;
}

export interface MetricValuesByMetricId {
  [metricId: string]: MetricValue;
}

/** metric id -> airport code -> value. Nested keying makes positional misalignment impossible. */
export interface MetricValuesByMetricAndAirport {
  [metricId: string]: {
    [iataCode: string]: number;
  };
}
