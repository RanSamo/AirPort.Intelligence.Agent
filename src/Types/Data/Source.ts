/**
 * Data provenance.
 *
 * Every number the agent reports must be traceable to one of these sources,
 * with the vintage attached. The agent states the window in every answer.
 */

export type DataSourceId =
  /** BTS On-Time Performance, flight-level. Congestion and haul mix. */
  | 'bts_otp'
  /** BTS T-100 Segment Summary by Origin Airport (Socrata). Passengers, seats, load factor. */
  | 't100_socrata'
  /** OurAirports reference CSV. Identity and geography. */
  | 'our_airports'
  /** FAA ACAIS enplanements workbook. Official enplanements and hub class. */
  | 'faa_enplanements'
  /** FAA NAS Status. Live ground stops and delay programs. */
  | 'faa_nas_status'
  /** OpenSky Network. Optional live movements. Never feeds a score. */
  | 'opensky'
  /** US Census / BEA. Catchment population and income. */
  | 'census'
  /** Hand-curated facility table in Data/Curated. */
  | 'curated'
  /** Computed by this system from one or more of the above. */
  | 'derived';

export interface SourceCitation {
  sourceId: DataSourceId;
  label: string;
  url: string;
  /** Data vintage, not fetch time: the newest period the source actually covers. */
  coverageThrough: string;
}

export interface SourceCitationsById {
  [sourceId: string]: SourceCitation;
}

/**
 * Identifies a build of the snapshot. Cache keys include this so that
 * re-running ingest cannot serve stale numbers.
 */
export interface DataVersion {
  /** Hash over the ingested source payloads. */
  hash: string;
  ingestedAt: string;
}
