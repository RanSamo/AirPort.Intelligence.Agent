import type { IataCode } from '../Domain/Airport';
import type { MonthKey } from '../Domain/Period';

/**
 * Spill model — estimating demand that was turned away.
 *
 * Standard airline spill analysis (Belobaba / Boeing spill tables). For an
 * airport-month with S seats and observed load factor:
 *
 *   1. assume latent demand D ~ Normal(mu, sigma), sigma = k * mu
 *   2. observed boardings = E[min(D, S)]
 *   3. solve numerically for mu
 *   4. spill = mu - E[min(D, S)];  spillRate = spill / mu
 *
 * IMPORTANT SCOPING (stated in every answer that uses this):
 * T-100 gives segment (nonstop) traffic summarized per airport, not true
 * origin-destination demand, and route-level load factors are not available
 * in any free source. So this is a LOWER BOUND: it ignores passengers
 * recaptured on other flights, other days, or nearby airports.
 */

export interface SpillEstimate {
  iata: IataCode;
  monthKey: MonthKey;
  seats: number;
  passengers: number;
  observedLoadFactor: number;
  /** Solved latent demand mu. */
  estimatedDemand: number;
  /** estimatedDemand - passengers. */
  spilledPassengers: number;
  /** spilledPassengers / estimatedDemand, 0-1. */
  spillRate: number;
  kFactor: number;
}

export interface SpillEstimatesByMonth {
  [monthKey: string]: SpillEstimate;
}

/**
 * Why demand appears to be unmet. Route-level load factors are unavailable,
 * so attribution is inferred from OTP flight counts and delay behaviour
 * rather than from per-route fill.
 */
export type UnmetDemandDriver =
  /** Aircraft are consistently full — seats are the binding constraint. */
  | 'seat_constrained'
  /** Departures flat while passengers grow — frequency is the binding constraint. */
  | 'frequency_constrained'
  /** Congestion is suppressing schedule growth. */
  | 'congestion_suppressed';

export interface UnmetDemandDriverEvidence {
  driver: UnmetDemandDriver;
  /** 0-1 share of the explanation attributed to this driver. */
  weight: number;
  narrative: string;
  supportingMetrics: string[];
}

export interface UnmetDemandAssessment {
  iata: IataCode;
  airportName: string;
  periodLabel: string;
  totalSpilledPassengers: number;
  averageSpillRate: number;
  peakMonth: MonthKey;
  monthly: SpillEstimatesByMonth;
  drivers: UnmetDemandDriverEvidence[];
  caveats: string[];
}
