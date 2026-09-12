/**
 * Airport identity and classification.
 *
 * IATA code is the primary key throughout the system: BTS T-100 and BTS OTP
 * both key on IATA, and it is what users type. ICAO is carried for the live
 * APIs (OpenSky expects ICAO).
 */

export type IataCode = string;
export type IcaoCode = string;
export type UsStateCode = string;

/**
 * FAA hub classification, derived from an airport's share of total US
 * enplanements in a calendar year.
 *   Large  >= 1%      Medium 0.25-1%      Small 0.05-0.25%      Nonhub < 0.05%
 *
 * Used as the peer cohort for normalization: comparing BOS to BDL on a
 * national scale is meaningless, so metrics are normalized within cohort.
 */
export type HubClass = 'Large' | 'Medium' | 'Small' | 'Nonhub';

export interface Airport {
  iata: IataCode;
  icao: IcaoCode | null;
  name: string;
  municipality: string;
  state: UsStateCode;
  latitude: number;
  longitude: number;
  hubClass: HubClass;
  /** Total enplaned passengers in the most recent complete calendar year. */
  annualEnplanements: number;
  /** This airport's share of total US enplanements, 0-1. */
  enplanementShare: number;
  /** True when the airport appears in BTS On-Time Performance reporting. */
  reportsOnTimePerformance: boolean;
}

export interface AirportsByCode {
  [iataCode: string]: Airport;
}

export interface AirportNamesByCode {
  [iataCode: string]: string;
}

/**
 * Result of resolving free text ("LA", "Santa Ana", "New England") to
 * concrete airports. Confidence drives whether the agent asks a clarifying
 * question instead of guessing.
 */
export interface AirportResolutionCandidate {
  airport: Airport;
  confidence: number;
  matchedOn: 'iata' | 'icao' | 'name' | 'municipality' | 'region' | 'state' | 'proximity';
}

export interface AirportResolution {
  candidates: AirportResolutionCandidate[];
  /** True when several candidates score similarly and the agent must ask. */
  isAmbiguous: boolean;
  query: string;
}
