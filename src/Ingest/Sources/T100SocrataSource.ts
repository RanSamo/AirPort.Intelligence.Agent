import { AirportCodeResolver } from '../AirportCodeResolver';
import { T100PageSize, T100SocrataEndpoint } from '../../Config/DataSources';
import type { IHttpFetcher } from '../../Types/Ports/Fetchers';
import type { IIngestSource, IngestContext, IngestOutcome } from '../../Types/Ports/IngestSources';
import type { ILogger } from '../../Types/Ports/Logger';
import type { SqliteConnection } from '../../Infrastructure/Database/SqliteConnection';

/**
 * BTS T-100 Segment Summary by Origin Airport (Socrata).
 *
 * Supplies passengers, seats and load factor at airport x month grain, plus
 * the domestic / international split. Load factor arrives precomputed, so no
 * derivation is needed.
 *
 * Field semantics, verified against SFO 2026-04:
 *   total_passengers (2,147,010)
 *     = domestic_passengers (1,563,451) + outbound_international_1 (583,559)
 * So "total" means passengers departing FROM this airport — enplanements.
 * Inbound international is reported separately and is deliberately not added.
 *
 * The Socrata column names are auto-generated and misleading:
 *   outbound_international    -> departure COUNT
 *   outbound_international_1  -> PASSENGERS
 */

/** Earliest month retained. Older data adds little and inflates the snapshot. */
const EarliestMonth = '2015-01-01';

/** Hub class is computed from the most recent complete calendar year. */
const HubClassYear = '2025';

const HubThresholds = {
  large: 0.01,
  medium: 0.0025,
  small: 0.0005,
};

interface T100ApiRow {
  origin_airport_code?: string;
  reporting_month?: string;
  total_departures?: string;
  total_passengers?: string;
  total_seats?: string;
  total_load_factor?: string;
  total_distance_passenger?: string;
  domestic_departures?: string;
  domestic_passengers?: string;
  domestic_seats?: string;
  outbound_international_1?: string;
}

interface TrafficInsertRow {
  iata: string;
  monthKey: string;
  departures: number;
  passengers: number;
  seats: number;
  loadFactor: number;
  domesticDepartures: number;
  domesticPassengers: number;
  domesticSeats: number;
  internationalPassengers: number;
  /** Passenger-weighted average journey length, statute miles. */
  passengerMilesAvg: number;
}

interface AnnualPassengersByCode {
  [iataCode: string]: number;
}

/** Keyed "IATA|YYYY-MM" while folding duplicate upstream codes together. */
interface TrafficRowsByKey {
  [airportMonthKey: string]: TrafficInsertRow;
}

export class T100SocrataSource implements IIngestSource {
  public readonly sourceId = 't100_socrata' as const;
  public readonly label = T100SocrataEndpoint.label;
  public readonly order = 20;

  private readonly fetcher: IHttpFetcher;
  private readonly database: SqliteConnection;
  private readonly logger: ILogger;

  constructor(fetcher: IHttpFetcher, database: SqliteConnection, logger: ILogger) {
    this.fetcher = fetcher;
    this.database = database;
    this.logger = logger;
  }

  public async Run(_context: IngestContext) {
    const startedAt = Date.now();
    const warnings: string[] = [];

    const resolver = AirportCodeResolver.FromDatabase(this.database);
    const apiRows = await this.FetchAllPages();

    const { rows, skippedCodes } = this.NormalizeRows(apiRows, resolver);
    this.WriteTrafficRows(rows);

    const latestMonth = rows.reduce((latest, row) => (row.monthKey > latest ? row.monthKey : latest), '');
    this.ApplyHubClassification(warnings);

    if (skippedCodes > 0) {
      warnings.push(
        `${skippedCodes} T-100 rows referenced airport codes absent from the US reference set (foreign endpoints on international segments) and were skipped.`,
      );
    }

    this.logger.Info('T-100 ingested', { rows: rows.length, latestMonth });

    const outcome: IngestOutcome = {
      sourceId: this.sourceId,
      rowsWritten: rows.length,
      coverageThrough: latestMonth,
      durationMs: Date.now() - startedAt,
      warnings,
    };
    return outcome;
  }

  private async FetchAllPages() {
    const selected = [
      'origin_airport_code',
      'reporting_month',
      'total_departures',
      'total_passengers',
      'total_seats',
      'total_load_factor',
      'total_distance_passenger',
      // Domestic halves are required wherever a T-100 average is combined
      // with an OTP flight count, because OTP is domestic-only.
      'domestic_departures',
      'domestic_passengers',
      'domestic_seats',
      'outbound_international_1',
    ].join(',');

    const collected: T100ApiRow[] = [];
    let offset = 0;

    for (;;) {
      const query =
        `${T100SocrataEndpoint.url}?$select=${selected}` +
        `&$where=${encodeURIComponent(`reporting_month >= '${EarliestMonth}'`)}` +
        `&$order=reporting_month,origin_airport_code` +
        `&$limit=${T100PageSize}&$offset=${offset}`;

      const page = await this.fetcher.FetchJson<T100ApiRow[]>(query, {
        ttlSeconds: T100SocrataEndpoint.ttlSeconds,
      });

      collected.push(...page);
      this.logger.Progress('T-100 rows fetched', collected.length, collected.length + page.length);

      if (page.length < T100PageSize) break;
      offset += T100PageSize;
    }

    return collected;
  }

  /**
   * Resolves codes and folds rows into one record per airport-month.
   *
   * Aggregation matters because two upstream codes can resolve to the same
   * canonical airport (BTS "PBI" and a stray "DJT" both land on DJT). Summing
   * keeps both; a plain insert would let the later row silently overwrite the
   * earlier one.
   *
   * Load factor is recomputed from summed seats and passengers rather than
   * carried over, since averaging two percentages of different sizes is wrong.
   */
  private NormalizeRows(apiRows: T100ApiRow[], resolver: AirportCodeResolver) {
    let skippedCodes = 0;

    const byAirportMonth = apiRows.reduce((accumulator: TrafficRowsByKey, apiRow) => {
      const monthKey = this.ToMonthKey(apiRow.reporting_month);
      if (!monthKey) return accumulator;

      // Resolves aliases and drops genuinely foreign endpoints that appear
      // on international segments.
      const iata = resolver.Resolve(apiRow.origin_airport_code);
      if (!iata) {
        skippedCodes += 1;
        return accumulator;
      }

      const key = `${iata}|${monthKey}`;
      const existing = accumulator[key];

      const departures = this.ToNumber(apiRow.total_departures);
      const passengers = this.ToNumber(apiRow.total_passengers);
      const seats = this.ToNumber(apiRow.total_seats);
      const domesticDepartures = this.ToNumber(apiRow.domestic_departures);
      const domesticPassengers = this.ToNumber(apiRow.domestic_passengers);
      const domesticSeats = this.ToNumber(apiRow.domestic_seats);
      const internationalPassengers = this.ToNumber(apiRow.outbound_international_1);
      const passengerMilesAvg = this.ToNumber(apiRow.total_distance_passenger);

      if (!existing) {
        accumulator[key] = {
          iata,
          monthKey,
          departures,
          passengers,
          seats,
          loadFactor: 0,
          domesticDepartures,
          domesticPassengers,
          domesticSeats,
          internationalPassengers,
          passengerMilesAvg,
        };
        return accumulator;
      }

      existing.departures += departures;
      existing.passengers += passengers;
      existing.seats += seats;
      existing.domesticDepartures += domesticDepartures;
      existing.domesticPassengers += domesticPassengers;
      existing.domesticSeats += domesticSeats;
      existing.internationalPassengers += internationalPassengers;
      // Already an average, so a passenger-weighted blend is the correct merge.
      existing.passengerMilesAvg =
        existing.passengers + passengers > 0
          ? (existing.passengerMilesAvg * existing.passengers + passengerMilesAvg * passengers) /
            (existing.passengers + passengers)
          : 0;
      return accumulator;
    }, {});

    const rows = Object.values(byAirportMonth).map((row) => ({
      ...row,
      loadFactor: row.seats > 0 ? row.passengers / row.seats : 0,
    }));

    return { rows, skippedCodes };
  }

  private WriteTrafficRows(rows: TrafficInsertRow[]) {
    const insert = this.database.Prepare<unknown>(`
      INSERT INTO traffic_months (
        iata, month_key, departures, passengers, seats, load_factor,
        domestic_departures, domestic_passengers, domestic_seats,
        international_passengers, passenger_miles_avg
      ) VALUES (
        @iata, @monthKey, @departures, @passengers, @seats, @loadFactor,
        @domesticDepartures, @domesticPassengers, @domesticSeats,
        @internationalPassengers, @passengerMilesAvg
      )
      ON CONFLICT(iata, month_key) DO UPDATE SET
        departures               = excluded.departures,
        passengers               = excluded.passengers,
        seats                    = excluded.seats,
        load_factor              = excluded.load_factor,
        domestic_departures      = excluded.domestic_departures,
        domestic_passengers      = excluded.domestic_passengers,
        domestic_seats           = excluded.domestic_seats,
        international_passengers = excluded.international_passengers,
        passenger_miles_avg      = excluded.passenger_miles_avg
    `);

    this.database.Transaction(() => {
      for (const row of rows) insert.run(row);
    });
  }

  /**
   * FAA hub classification, derived from each airport's share of total US
   * enplanements in the reference calendar year:
   *   Large >= 1%   Medium 0.25-1%   Small 0.05-0.25%   Nonhub < 0.05%
   *
   * Computed rather than read from the FAA workbook so that hub class,
   * enplanements and share all come from one internally consistent source.
   */
  private ApplyHubClassification(warnings: string[]) {
    const annualRows = this.database
      .Prepare<{ iata: string; passengers: number }>(
        `SELECT iata, SUM(passengers) AS passengers
           FROM traffic_months
          WHERE substr(month_key, 1, 4) = ?
       GROUP BY iata`,
      )
      .all(HubClassYear);

    if (annualRows.length === 0) {
      warnings.push(`No T-100 data for ${HubClassYear}; hub classification was skipped.`);
      return;
    }

    const annualByCode = annualRows.reduce((accumulator: AnnualPassengersByCode, row) => {
      accumulator[row.iata] = row.passengers;
      return accumulator;
    }, {});

    const nationalTotal = Object.values(annualByCode).reduce((sum, value) => sum + value, 0);
    if (nationalTotal <= 0) {
      warnings.push('National enplanement total was zero; hub classification was skipped.');
      return;
    }

    const update = this.database.Prepare<unknown>(`
      UPDATE airports
         SET annual_enplanements = @passengers,
             enplanement_share   = @share,
             hub_class           = @hubClass
       WHERE iata = @iata
    `);

    this.database.Transaction(() => {
      for (const [iata, passengers] of Object.entries(annualByCode)) {
        const share = passengers / nationalTotal;
        update.run({ iata, passengers, share, hubClass: this.ClassifyHub(share) });
      }
    });

    this.logger.Info('Hub classification applied', {
      year: HubClassYear,
      airports: Object.keys(annualByCode).length,
      nationalEnplanements: nationalTotal,
    });
  }

  private ClassifyHub(share: number) {
    if (share >= HubThresholds.large) return 'Large';
    if (share >= HubThresholds.medium) return 'Medium';
    if (share >= HubThresholds.small) return 'Small';
    return 'Nonhub';
  }

  /** "2026-04-01T00:00:00.000" -> "2026-04" */
  private ToMonthKey(reportingMonth: string | undefined) {
    if (!reportingMonth || reportingMonth.length < 7) return '';
    return reportingMonth.slice(0, 7);
  }

  private ToNumber(raw: string | undefined) {
    if (raw === undefined || raw === '') return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
