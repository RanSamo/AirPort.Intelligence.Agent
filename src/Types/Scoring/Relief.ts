import type { HubClass, IataCode } from '../Domain/Airport';

/**
 * Secondary-airport analysis.
 *
 * A real institutional thesis: rather than fight for capacity at a
 * constrained mega-hub, invest in a nearby airport that can absorb the
 * overflow. Ontario instead of Los Angeles, Providence instead of Boston.
 *
 * The question has two halves, and both must hold. Is the primary airport
 * actually constrained? And does the neighbour have genuine headroom -
 * physical room, regulatory freedom, and enough catchment overlap that
 * spilled demand could plausibly reach it?
 */

/** Why an alternative does or does not work as relief. */
export type ReliefSignal =
  /** Aircraft are not full, so it can absorb passengers without new flights. */
  | 'seat_headroom'
  /** Little queueing delay, so it can absorb more movements. */
  | 'airfield_headroom'
  /** Already growing quickly, evidence carriers are shifting capacity here. */
  | 'already_absorbing'
  /** Regulation caps how much it could ever take. */
  | 'regulatory_ceiling'
  /** Already as constrained as the primary, so it relieves nothing. */
  | 'no_headroom';

export interface ReliefEvidence {
  signal: ReliefSignal;
  narrative: string;
}

export interface ReliefCandidate {
  iata: IataCode;
  name: string;
  hubClass: HubClass;
  distanceKm: number;
  annualPassengers: number;
  /** 0-100. Higher means more able to absorb overflow. */
  headroomScore: number;
  loadFactor: number | null;
  spillRate: number | null;
  taxiOutP90: number | null;
  /** Composite expansion score, for comparison with the primary. */
  expansionScore: number | null;
  evidence: ReliefEvidence[];
  isViable: boolean;
}

export interface PrimaryConstraintProfile {
  iata: IataCode;
  name: string;
  loadFactor: number | null;
  spillRate: number | null;
  taxiOutP90: number | null;
  /** True when the primary is constrained enough for relief to be relevant. */
  isConstrained: boolean;
  narrative: string;
}

export interface ReliefAssessment {
  primary: PrimaryConstraintProfile;
  radiusKm: number;
  candidates: ReliefCandidate[];
  narrative: string;
  caveats: string[];
}
