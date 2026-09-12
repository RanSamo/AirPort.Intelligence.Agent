import type { ITrafficRepository, TrafficMonthRecord } from '../Types/Ports/Repositories';
import type { SqliteConnection } from '../Infrastructure/Database/SqliteConnection';

const SelectColumns = `
  iata,
  month_key                AS monthKey,
  departures,
  passengers,
  seats,
  load_factor              AS loadFactor,
  domestic_departures      AS domesticDepartures,
  domestic_passengers      AS domesticPassengers,
  domestic_seats           AS domesticSeats,
  international_passengers AS internationalPassengers,
  passenger_miles_avg      AS passengerMilesAvg
`;

export class SqliteTrafficRepository implements ITrafficRepository {
  private readonly database: SqliteConnection;

  constructor(database: SqliteConnection) {
    this.database = database;
  }

  public GetMonths(iata: string, from: string, to: string) {
    return this.database
      .Prepare<TrafficMonthRecord>(
        `SELECT ${SelectColumns}
           FROM traffic_months
          WHERE iata = ? AND month_key BETWEEN ? AND ?
       ORDER BY month_key`,
      )
      .all(iata, from, to);
  }

  public GetAllInRange(from: string, to: string) {
    return this.database
      .Prepare<TrafficMonthRecord>(
        `SELECT ${SelectColumns}
           FROM traffic_months
          WHERE month_key BETWEEN ? AND ?
       ORDER BY iata, month_key`,
      )
      .all(from, to);
  }

  public GetAvailableRange() {
    const row = this.database
      .Prepare<{ from: string; to: string }>(
        'SELECT MIN(month_key) AS "from", MAX(month_key) AS "to" FROM traffic_months',
      )
      .get();
    return { from: row?.from ?? '', to: row?.to ?? '' };
  }
}
