import type { CongestionMonthRecord, HaulMixRecord, ICongestionRepository } from '../Types/Ports/Repositories';
import type { SqliteConnection } from '../Infrastructure/Database/SqliteConnection';

const CongestionColumns = `
  iata,
  month_key                   AS monthKey,
  flights,
  taxi_out_p50                AS taxiOutP50,
  taxi_out_p90                AS taxiOutP90,
  departures_delayed_15       AS departuresDelayed15,
  cancelled,
  nas_delay_minutes           AS nasDelayMinutes,
  weather_delay_minutes       AS weatherDelayMinutes,
  carrier_delay_minutes       AS carrierDelayMinutes,
  late_aircraft_delay_minutes AS lateAircraftDelayMinutes,
  security_delay_minutes      AS securityDelayMinutes,
  peak_hour_departures        AS peakHourDepartures
`;

const HaulColumns = `
  iata,
  month_key           AS monthKey,
  short_haul_flights  AS shortHaulFlights,
  medium_haul_flights AS mediumHaulFlights,
  long_haul_flights   AS longHaulFlights,
  total_flights       AS totalFlights
`;

export class SqliteCongestionRepository implements ICongestionRepository {
  private readonly database: SqliteConnection;

  constructor(database: SqliteConnection) {
    this.database = database;
  }

  public GetMonths(iata: string, from: string, to: string) {
    return this.database
      .Prepare<CongestionMonthRecord>(
        `SELECT ${CongestionColumns}
           FROM congestion_months
          WHERE iata = ? AND month_key BETWEEN ? AND ?
       ORDER BY month_key`,
      )
      .all(iata, from, to);
  }

  public GetAllInRange(from: string, to: string) {
    return this.database
      .Prepare<CongestionMonthRecord>(
        `SELECT ${CongestionColumns}
           FROM congestion_months
          WHERE month_key BETWEEN ? AND ?
       ORDER BY iata, month_key`,
      )
      .all(from, to);
  }

  public GetHaulMix(iata: string, from: string, to: string) {
    return this.database
      .Prepare<HaulMixRecord>(
        `SELECT ${HaulColumns}
           FROM haul_mix_months
          WHERE iata = ? AND month_key BETWEEN ? AND ?
       ORDER BY month_key`,
      )
      .all(iata, from, to);
  }

  public GetAllHaulMixInRange(from: string, to: string) {
    return this.database
      .Prepare<HaulMixRecord>(
        `SELECT ${HaulColumns}
           FROM haul_mix_months
          WHERE month_key BETWEEN ? AND ?
       ORDER BY iata, month_key`,
      )
      .all(from, to);
  }

  public HasData(iata: string) {
    const row = this.database
      .Prepare<{ n: number }>('SELECT COUNT(*) AS n FROM congestion_months WHERE iata = ?')
      .get(iata);
    return (row?.n ?? 0) > 0;
  }

  public GetAvailableRange() {
    const row = this.database
      .Prepare<{ from: string; to: string }>(
        'SELECT MIN(month_key) AS "from", MAX(month_key) AS "to" FROM congestion_months',
      )
      .get();
    return { from: row?.from ?? '', to: row?.to ?? '' };
  }
}
