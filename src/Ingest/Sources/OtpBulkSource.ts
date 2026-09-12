import { AirportCodeResolver } from '../AirportCodeResolver';
import { BuildOtpArchiveUrl, HaulDistanceBands, OtpSourceMeta } from '../../Config/DataSources';
import { EnumerateMonths, FormatMonthKey } from '../../Infrastructure/Time/MonthSequence';
import { ParseNumber } from '../Parsers/CsvStreamParser';
import type { CsvStreamParser } from '../Parsers/CsvStreamParser';
import type { IHttpFetcher } from '../../Types/Ports/Fetchers';
import type { IIngestSource, IngestContext, IngestOutcome } from '../../Types/Ports/IngestSources';
import type { ILogger } from '../../Types/Ports/Logger';
import type { SqliteConnection } from '../../Infrastructure/Database/SqliteConnection';
import type { ZipEntryReader } from '../Parsers/ZipEntryReader';

/**
 * BTS On-Time Performance — congestion and haul mix.
 *
 * Each monthly archive is ~31MB compressed and ~275MB uncompressed at
 * roughly 600k flight rows. Rows are streamed, folded into per-airport
 * accumulators, and discarded immediately; individual flights are never
 * stored and never held in an array. Peak memory is bounded by the number of
 * airports, not by the size of the archive.
 *
 * Taxi-out percentiles use a fixed histogram rather than retained samples.
 * BTS reports TaxiOut in whole minutes, so a bounded bucket array yields
 * exact percentiles at a fraction of the memory of keeping every value.
 */

/** Covers taxi-out times up to 8 hours; anything beyond lands in the final bucket. */
const TaxiHistogramBuckets = 512;
const HoursPerDay = 24;
const MaxDaysPerMonth = 31;

interface AirportMonthAccumulator {
  flights: number;
  taxiOutHistogram: Int32Array;
  taxiOutSamples: number;
  departuresDelayed15: number;
  cancelled: number;
  nasDelayMinutes: number;
  weatherDelayMinutes: number;
  carrierDelayMinutes: number;
  lateAircraftDelayMinutes: number;
  securityDelayMinutes: number;
  /** Scheduled departures per (day, hour) slot; drives peak-hour utilisation. */
  hourlyDepartures: Int32Array;
  shortHaulFlights: number;
  mediumHaulFlights: number;
  longHaulFlights: number;
}

interface AccumulatorsByCode {
  [iataCode: string]: AirportMonthAccumulator;
}

export class OtpBulkSource implements IIngestSource {
  public readonly sourceId = 'bts_otp' as const;
  public readonly label = OtpSourceMeta.label;
  public readonly order = 30;

  private readonly fetcher: IHttpFetcher;
  private readonly database: SqliteConnection;
  private readonly parser: CsvStreamParser;
  private readonly zipReader: ZipEntryReader;
  private readonly logger: ILogger;

  constructor(
    fetcher: IHttpFetcher,
    database: SqliteConnection,
    parser: CsvStreamParser,
    zipReader: ZipEntryReader,
    logger: ILogger,
  ) {
    this.fetcher = fetcher;
    this.database = database;
    this.parser = parser;
    this.zipReader = zipReader;
    this.logger = logger;
  }

  public async Run(context: IngestContext) {
    const startedAt = Date.now();
    const warnings: string[] = [];

    const resolver = AirportCodeResolver.FromDatabase(this.database);
    const months = EnumerateMonths(context.otpFrom, context.otpTo);

    let rowsWritten = 0;
    let latestMonth = '';
    let monthsCompleted = 0;

    for (const yearMonth of months) {
      const monthKey = FormatMonthKey(yearMonth);
      try {
        const written = await this.IngestMonth(yearMonth.year, yearMonth.month, monthKey, resolver);
        rowsWritten += written;
        if (monthKey > latestMonth) latestMonth = monthKey;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`${monthKey}: ${message}`);
        this.logger.Warn(`OTP month failed, continuing`, { monthKey, message });
      }

      monthsCompleted += 1;
      this.logger.Progress('OTP months ingested', monthsCompleted, months.length);
    }

    this.FlagOnTimeReportingAirports();

    const outcome: IngestOutcome = {
      sourceId: this.sourceId,
      rowsWritten,
      coverageThrough: latestMonth,
      durationMs: Date.now() - startedAt,
      warnings,
    };
    return outcome;
  }

  private async IngestMonth(year: number, month: number, monthKey: string, resolver: AirportCodeResolver) {
    const url = BuildOtpArchiveUrl(year, month);
    const archivePath = await this.fetcher.FetchToFile(url, { ttlSeconds: OtpSourceMeta.ttlSeconds });

    const csvStream = await this.zipReader.OpenCsvEntry(archivePath);
    const accumulators: AccumulatorsByCode = {};

    for await (const row of this.parser.Rows(csvStream)) {
      const origin = resolver.Resolve(row.Origin);
      if (!origin) continue;

      const accumulator = this.EnsureAccumulator(accumulators, origin);
      this.FoldRow(accumulator, row);
    }

    return this.WriteMonth(monthKey, accumulators);
  }

  private FoldRow(accumulator: AirportMonthAccumulator, row: { [column: string]: string }) {
    accumulator.flights += 1;

    const isCancelled = ParseNumber(row.Cancelled) === 1;
    if (isCancelled) accumulator.cancelled += 1;

    if (ParseNumber(row.DepDel15) === 1) accumulator.departuresDelayed15 += 1;

    // Cancelled flights never pushed back, so they carry no taxi time.
    if (!isCancelled) {
      const taxiOut = ParseNumber(row.TaxiOut);
      if (taxiOut > 0) {
        const bucket = Math.min(Math.floor(taxiOut), TaxiHistogramBuckets - 1);
        accumulator.taxiOutHistogram[bucket] += 1;
        accumulator.taxiOutSamples += 1;
      }
    }

    accumulator.nasDelayMinutes += ParseNumber(row.NASDelay);
    accumulator.weatherDelayMinutes += ParseNumber(row.WeatherDelay);
    accumulator.carrierDelayMinutes += ParseNumber(row.CarrierDelay);
    accumulator.lateAircraftDelayMinutes += ParseNumber(row.LateAircraftDelay);
    accumulator.securityDelayMinutes += ParseNumber(row.SecurityDelay);

    this.FoldScheduledHour(accumulator, row);
    this.FoldHaulBand(accumulator, ParseNumber(row.Distance));
  }

  /** CRSDepTime is an HHMM integer, e.g. 1435. Empty or malformed values are ignored. */
  private FoldScheduledHour(accumulator: AirportMonthAccumulator, row: { [column: string]: string }) {
    const dayOfMonth = ParseNumber(row.DayofMonth);
    const scheduled = ParseNumber(row.CRSDepTime);
    if (dayOfMonth < 1 || dayOfMonth > MaxDaysPerMonth || scheduled <= 0) return;

    const hour = Math.min(Math.floor(scheduled / 100), HoursPerDay - 1);
    accumulator.hourlyDepartures[(dayOfMonth - 1) * HoursPerDay + hour] += 1;
  }

  private FoldHaulBand(accumulator: AirportMonthAccumulator, distanceMiles: number) {
    if (distanceMiles <= 0) return;
    if (distanceMiles <= HaulDistanceBands.shortHaulMaxMiles) accumulator.shortHaulFlights += 1;
    else if (distanceMiles <= HaulDistanceBands.mediumHaulMaxMiles) accumulator.mediumHaulFlights += 1;
    else accumulator.longHaulFlights += 1;
  }

  private WriteMonth(monthKey: string, accumulators: AccumulatorsByCode) {
    const insertCongestion = this.database.Prepare<unknown>(`
      INSERT INTO congestion_months (
        iata, month_key, flights, taxi_out_p50, taxi_out_p90,
        departures_delayed_15, cancelled, nas_delay_minutes, weather_delay_minutes,
        carrier_delay_minutes, late_aircraft_delay_minutes, security_delay_minutes,
        peak_hour_departures
      ) VALUES (
        @iata, @monthKey, @flights, @taxiOutP50, @taxiOutP90,
        @departuresDelayed15, @cancelled, @nasDelayMinutes, @weatherDelayMinutes,
        @carrierDelayMinutes, @lateAircraftDelayMinutes, @securityDelayMinutes,
        @peakHourDepartures
      )
      ON CONFLICT(iata, month_key) DO UPDATE SET
        flights                     = excluded.flights,
        taxi_out_p50                = excluded.taxi_out_p50,
        taxi_out_p90                = excluded.taxi_out_p90,
        departures_delayed_15       = excluded.departures_delayed_15,
        cancelled                   = excluded.cancelled,
        nas_delay_minutes           = excluded.nas_delay_minutes,
        weather_delay_minutes       = excluded.weather_delay_minutes,
        carrier_delay_minutes       = excluded.carrier_delay_minutes,
        late_aircraft_delay_minutes = excluded.late_aircraft_delay_minutes,
        security_delay_minutes      = excluded.security_delay_minutes,
        peak_hour_departures        = excluded.peak_hour_departures
    `);

    const insertHaul = this.database.Prepare<unknown>(`
      INSERT INTO haul_mix_months (
        iata, month_key, short_haul_flights, medium_haul_flights, long_haul_flights, total_flights
      ) VALUES (
        @iata, @monthKey, @shortHaulFlights, @mediumHaulFlights, @longHaulFlights, @totalFlights
      )
      ON CONFLICT(iata, month_key) DO UPDATE SET
        short_haul_flights  = excluded.short_haul_flights,
        medium_haul_flights = excluded.medium_haul_flights,
        long_haul_flights   = excluded.long_haul_flights,
        total_flights       = excluded.total_flights
    `);

    const entries = Object.entries(accumulators);

    this.database.Transaction(() => {
      for (const [iata, accumulator] of entries) {
        insertCongestion.run({
          iata,
          monthKey,
          flights: accumulator.flights,
          taxiOutP50: this.PercentileFromHistogram(accumulator, 0.5),
          taxiOutP90: this.PercentileFromHistogram(accumulator, 0.9),
          departuresDelayed15: accumulator.departuresDelayed15,
          cancelled: accumulator.cancelled,
          nasDelayMinutes: accumulator.nasDelayMinutes,
          weatherDelayMinutes: accumulator.weatherDelayMinutes,
          carrierDelayMinutes: accumulator.carrierDelayMinutes,
          lateAircraftDelayMinutes: accumulator.lateAircraftDelayMinutes,
          securityDelayMinutes: accumulator.securityDelayMinutes,
          peakHourDepartures: this.PeakHourDepartures(accumulator),
        });

        insertHaul.run({
          iata,
          monthKey,
          shortHaulFlights: accumulator.shortHaulFlights,
          mediumHaulFlights: accumulator.mediumHaulFlights,
          longHaulFlights: accumulator.longHaulFlights,
          totalFlights:
            accumulator.shortHaulFlights + accumulator.mediumHaulFlights + accumulator.longHaulFlights,
        });
      }
    });

    return entries.length;
  }

  /** Exact percentile over whole-minute taxi-out buckets. */
  private PercentileFromHistogram(accumulator: AirportMonthAccumulator, percentile: number) {
    if (accumulator.taxiOutSamples === 0) return 0;

    const target = accumulator.taxiOutSamples * percentile;
    let cumulative = 0;

    for (let bucket = 0; bucket < TaxiHistogramBuckets; bucket += 1) {
      cumulative += accumulator.taxiOutHistogram[bucket];
      if (cumulative >= target) return bucket;
    }
    return TaxiHistogramBuckets - 1;
  }

  /**
   * 95th percentile of departures in a single clock hour, across the hours
   * that actually had traffic. Empty overnight hours are excluded so they do
   * not drag the peak measure down.
   */
  private PeakHourDepartures(accumulator: AirportMonthAccumulator) {
    const active = Array.from(accumulator.hourlyDepartures).filter((count) => count > 0);
    if (active.length === 0) return 0;

    active.sort((left, right) => left - right);
    const index = Math.min(active.length - 1, Math.floor(active.length * 0.95));
    return active[index];
  }

  private EnsureAccumulator(accumulators: AccumulatorsByCode, iata: string) {
    const existing = accumulators[iata];
    if (existing) return existing;

    const created: AirportMonthAccumulator = {
      flights: 0,
      taxiOutHistogram: new Int32Array(TaxiHistogramBuckets),
      taxiOutSamples: 0,
      departuresDelayed15: 0,
      cancelled: 0,
      nasDelayMinutes: 0,
      weatherDelayMinutes: 0,
      carrierDelayMinutes: 0,
      lateAircraftDelayMinutes: 0,
      securityDelayMinutes: 0,
      hourlyDepartures: new Int32Array(MaxDaysPerMonth * HoursPerDay),
      shortHaulFlights: 0,
      mediumHaulFlights: 0,
      longHaulFlights: 0,
    };
    accumulators[iata] = created;
    return created;
  }

  /**
   * Marks which airports appear in OTP at all.
   *
   * Only carriers above 0.5% of domestic revenue must report, so roughly 350
   * of the ~1,220 airports in the snapshot have congestion data. This flag is
   * what lets a ranking exclude the rest with a specific reason rather than a
   * vague "insufficient data".
   */
  private FlagOnTimeReportingAirports() {
    this.database.Exec(`
      UPDATE airports
         SET reports_otp = 1
       WHERE iata IN (SELECT DISTINCT iata FROM congestion_months)
    `);
  }

}
