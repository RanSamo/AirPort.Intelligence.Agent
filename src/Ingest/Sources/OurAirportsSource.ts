import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

import { OurAirportsEndpoint } from '../../Config/DataSources';
import type { CsvRow, CsvStreamParser } from '../Parsers/CsvStreamParser';
import type { IHttpFetcher } from '../../Types/Ports/Fetchers';
import type { IIngestSource, IngestContext, IngestOutcome } from '../../Types/Ports/IngestSources';
import type { ILogger } from '../../Types/Ports/Logger';
import type { SqliteConnection } from '../../Infrastructure/Database/SqliteConnection';

/**
 * Airport identity and geography from OurAirports.
 *
 * Runs first: it seeds the airports table that every later source updates.
 * Hub class and enplanements are left at their defaults and filled in by the
 * T-100 source, the only place actual passenger counts exist.
 *
 * Two subtleties, both discovered by auditing ingest against upstream:
 *
 *  1. US territories carry their own iso_country (PR, VI, GU, AS, MP), not
 *     'US'. Filtering on 'US' alone drops San Juan, Guam and the USVI —
 *     San Juan alone is 6.7M passengers and a Medium hub.
 *
 *  2. The reference and traffic sources disagree on codes. OurAirports lists
 *     West Palm Beach under a renamed DJT while BTS still reports PBI, and
 *     small airports appear in BTS under FAA local codes (1G4, A43). Each
 *     airport therefore registers alias codes alongside its canonical one.
 */

interface FlagSet {
  [key: string]: true;
}

/** US and its territories. BTS treats all of these as domestic US traffic. */
const IncludedCountries: FlagSet = {
  US: true,
  PR: true,
  VI: true,
  GU: true,
  AS: true,
  MP: true,
  UM: true,
};

/**
 * Seaplane bases are kept deliberately: many in Alaska carry scheduled
 * service and appear in T-100, and the brief asks for every US airport the
 * public data covers.
 */
const KeptTypes: FlagSet = {
  large_airport: true,
  medium_airport: true,
  small_airport: true,
  seaplane_base: true,
};

const RegionPattern = /^[A-Z]{2}-(?<state>[A-Z0-9]{1,3})/;
const AirportCodePattern = /^[A-Z0-9]{3}$/;
const UsIcaoPattern = /^K(?<code>[A-Z]{3})$/;

interface AirportInsertRow {
  iata: string;
  icao: string | null;
  name: string;
  municipality: string;
  state: string;
  latitude: number | null;
  longitude: number | null;
}

interface AliasCandidate {
  alias: string;
  iata: string;
  origin: string;
}

export class OurAirportsSource implements IIngestSource {
  public readonly sourceId = 'our_airports' as const;
  public readonly label = OurAirportsEndpoint.label;
  public readonly order = 10;

  private readonly fetcher: IHttpFetcher;
  private readonly database: SqliteConnection;
  private readonly parser: CsvStreamParser;
  private readonly logger: ILogger;

  constructor(fetcher: IHttpFetcher, database: SqliteConnection, parser: CsvStreamParser, logger: ILogger) {
    this.fetcher = fetcher;
    this.database = database;
    this.parser = parser;
    this.logger = logger;
  }

  public async Run(_context: IngestContext) {
    const startedAt = Date.now();
    const warnings: string[] = [];

    const csvPath = await this.fetcher.FetchToFile(OurAirportsEndpoint.url, {
      ttlSeconds: OurAirportsEndpoint.ttlSeconds,
    });

    const { airports, aliases } = await this.CollectAirports(csvPath);

    this.WriteAirports(airports);
    const aliasesWritten = this.WriteAliases(aliases);

    if (airports.length === 0) {
      warnings.push('OurAirports returned no US airports — check the upstream CSV format.');
    }

    this.logger.Info('OurAirports ingested', { airports: airports.length, aliases: aliasesWritten });

    const outcome: IngestOutcome = {
      sourceId: this.sourceId,
      rowsWritten: airports.length,
      coverageThrough: 'current',
      durationMs: Date.now() - startedAt,
      warnings,
    };
    return outcome;
  }

  private async CollectAirports(csvPath: string) {
    const source = createReadStream(csvPath) as unknown as Readable;

    const airports: AirportInsertRow[] = [];
    const aliases: AliasCandidate[] = [];

    for await (const row of this.parser.Rows(source)) {
      if (!IncludedCountries[row.iso_country]) continue;
      if (!KeptTypes[row.type]) continue;

      const canonical = this.ResolveCanonicalCode(row);
      if (!canonical) continue;

      airports.push({
        iata: canonical,
        icao: this.Clean(row.icao_code) || null,
        name: row.name ?? canonical,
        municipality: row.municipality ?? '',
        state: this.ResolveState(row.iso_region),
        latitude: Number(row.latitude_deg) || null,
        longitude: Number(row.longitude_deg) || null,
      });

      for (const candidate of this.ResolveAliases(row, canonical)) aliases.push(candidate);
    }

    return { airports, aliases };
  }

  /**
   * The code this airport is stored under. IATA when present, otherwise the
   * FAA local code, otherwise a US ICAO ident with its leading K stripped.
   */
  private ResolveCanonicalCode(row: CsvRow) {
    const iata = this.Clean(row.iata_code);
    if (AirportCodePattern.test(iata)) return iata;

    const localCode = this.Clean(row.local_code);
    if (AirportCodePattern.test(localCode)) return localCode;

    const identMatch = UsIcaoPattern.exec(this.Clean(row.ident));
    if (identMatch?.groups?.code) return identMatch.groups.code;

    return '';
  }

  /**
   * Every other code this airport is known by. Keywords are included because
   * that is where OurAirports retains a superseded code after a rename —
   * it is the only machine-readable link from BTS's PBI to the current DJT.
   */
  private ResolveAliases(row: CsvRow, canonical: string) {
    const candidates: AliasCandidate[] = [];

    const register = (rawValue: string, origin: string) => {
      const value = this.Clean(rawValue);
      if (!AirportCodePattern.test(value) || value === canonical) return;
      candidates.push({ alias: value, iata: canonical, origin });
    };

    register(row.iata_code, 'iata_code');
    register(row.local_code, 'local_code');

    const identMatch = UsIcaoPattern.exec(this.Clean(row.ident));
    if (identMatch?.groups?.code) register(identMatch.groups.code, 'ident');

    for (const token of (row.keywords ?? '').split(',')) {
      register(token, 'keywords');
    }

    return candidates;
  }

  private ResolveState(isoRegion: string | undefined) {
    const match = RegionPattern.exec(isoRegion ?? '');
    return match?.groups?.state ?? '';
  }

  private WriteAirports(airports: AirportInsertRow[]) {
    const insert = this.database.Prepare<unknown>(`
      INSERT INTO airports (iata, icao, name, municipality, state, latitude, longitude)
      VALUES (@iata, @icao, @name, @municipality, @state, @latitude, @longitude)
      ON CONFLICT(iata) DO UPDATE SET
        icao         = excluded.icao,
        name         = excluded.name,
        municipality = excluded.municipality,
        state        = excluded.state,
        latitude     = excluded.latitude,
        longitude    = excluded.longitude
    `);

    this.database.Transaction(() => {
      for (const airport of airports) insert.run(airport);
    });
  }

  /**
   * Aliases never shadow a canonical code. The guard subquery means that if
   * some other airport legitimately owns a code, the alias is dropped rather
   * than hijacking it.
   */
  private WriteAliases(aliases: AliasCandidate[]) {
    const insert = this.database.Prepare<unknown>(`
      INSERT OR IGNORE INTO airport_aliases (alias, iata, origin)
      SELECT @alias, @iata, @origin
       WHERE NOT EXISTS (SELECT 1 FROM airports WHERE iata = @alias)
    `);

    let written = 0;
    this.database.Transaction(() => {
      for (const alias of aliases) {
        const result = insert.run(alias);
        written += result.changes;
      }
    });
    return written;
  }

  private Clean(value: string | undefined) {
    return (value ?? '').trim().toUpperCase();
  }
}
