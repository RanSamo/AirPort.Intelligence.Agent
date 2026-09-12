import type { SqliteConnection } from '../Infrastructure/Database/SqliteConnection';

/**
 * Maps an upstream airport code onto the snapshot's canonical code.
 *
 * BTS and OurAirports do not always agree. BTS reports West Palm Beach as
 * PBI while OurAirports has renamed it DJT; small airports appear in BTS
 * under FAA local codes. Resolving through the alias table keeps those
 * airports joined instead of silently dropped.
 *
 * Built once per ingest source and held in memory — it is consulted once per
 * CSV row, and an OTP month has roughly 600k of them.
 */

interface CodeLookup {
  [code: string]: string;
}

export class AirportCodeResolver {
  private readonly lookup: CodeLookup;

  private constructor(lookup: CodeLookup) {
    this.lookup = lookup;
  }

  public static FromDatabase(database: SqliteConnection) {
    // Canonical codes load first so an alias can never shadow a real airport.
    const canonical = database
      .Prepare<{ iata: string }>('SELECT iata FROM airports')
      .all()
      .reduce((accumulator: CodeLookup, row) => {
        accumulator[row.iata] = row.iata;
        return accumulator;
      }, {});

    const withAliases = database
      .Prepare<{ alias: string; iata: string }>('SELECT alias, iata FROM airport_aliases')
      .all()
      .reduce((accumulator: CodeLookup, row) => {
        if (!accumulator[row.alias]) accumulator[row.alias] = row.iata;
        return accumulator;
      }, canonical);

    return new AirportCodeResolver(withAliases);
  }

  /** Returns the canonical code, or empty string when the airport is unknown. */
  public Resolve(rawCode: string | undefined) {
    if (!rawCode) return '';
    return this.lookup[rawCode.trim().toUpperCase()] ?? '';
  }

  public Size() {
    return Object.keys(this.lookup).length;
  }
}
