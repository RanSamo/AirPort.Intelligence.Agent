import type { IataCode } from './Airport';

/**
 * Hand-curated facility data.
 *
 * There is no public API for gate counts, runway capacity, or slot rules, so
 * these are curated by hand. Every value carries its source so the agent can
 * cite it, and so a reviewer can audit it.
 *
 * HOUSE RULE: no guessing. An airport absent from this table simply has no
 * gate count — the Constraint pillar reweights over its remaining metrics and
 * the gap is disclosed to the user. Nothing is ever estimated or interpolated.
 */
export interface CuratedValue<TValue> {
  value: TValue;
  sourceUrl: string;
  /** ISO date the value was read from the source. */
  retrievedDate: string;
  /** Free-text note, e.g. "includes 6 international gates at Terminal B". */
  note?: string;
}

/**
 * Structural constraints that cap how much of a capacity investment can
 * actually be realized. Applied as a multiplier, not a weighted adder,
 * because they gate the whole thesis rather than contributing to it.
 */
export interface FeasibilityFlags {
  /** FAA slot-controlled (JFK, LGA, DCA). New terminal capacity cannot be filled with new flights. */
  slotControlled: boolean;
  /** Perimeter rule restricting long-haul service (DCA, LGA). */
  perimeterRule: boolean;
  /**
   * Physically boxed in with no room to extend the airfield.
   * Discounts airfield projects but *raises* terminal-only projects: when
   * vertical expansion is the only option, terminal capex is the whole thesis.
   */
  landConstrained: boolean;
}

export interface AirportFacilityRecord {
  iata: IataCode;
  /** Absent when no authoritative gate count could be sourced. */
  gateCount?: CuratedValue<number>;
  /** Absent when the airport is outside FAA FACT3 coverage (~48 airports). */
  hourlyCapacity?: CuratedValue<number>;
  runwayCount?: CuratedValue<number>;
  feasibility: FeasibilityFlags;
}

export interface FacilityRecordsByCode {
  [iataCode: string]: AirportFacilityRecord;
}

// --- Shape of Data/Curated/AirportFacilities.json ---------------------------

export interface CuratedSourceReference {
  label: string;
  url: string;
  retrievedDate: string;
}

export interface CuratedSourcesByField {
  [field: string]: CuratedSourceReference;
}

export interface CuratedGateEntry {
  count: number;
  sourceUrl: string;
  retrievedDate: string;
  note?: string;
}

export interface CuratedAirportEntry {
  iata: string;
  feasibility?: Partial<FeasibilityFlags>;
  gates?: CuratedGateEntry;
  hourlyCapacity?: CuratedGateEntry;
  runways?: CuratedGateEntry;
}

export interface CuratedFacilitiesFile {
  defaults: { feasibility: FeasibilityFlags };
  airports: CuratedAirportEntry[];
  sources: CuratedSourcesByField;
}
