import type { IMetricRepository, MetricValueRow } from '../Types/Ports/Repositories';
import type { MetricId, MetricValuesByMetricAndAirport } from '../Types/Domain/Metric';
import type { SqliteConnection } from '../Infrastructure/Database/SqliteConnection';

interface RawMetricRow {
  iata: string;
  metricId: string;
  value: number;
}

export class SqliteMetricRepository implements IMetricRepository {
  private readonly database: SqliteConnection;

  constructor(database: SqliteConnection) {
    this.database = database;
  }

  public GetForAirports(codes: string[], metricIds: MetricId[], periodId: string) {
    if (codes.length === 0 || metricIds.length === 0) return {};

    const codePlaceholders = new Array(codes.length).fill('?').join(',');
    const metricPlaceholders = new Array(metricIds.length).fill('?').join(',');

    const rows = this.database
      .Prepare<RawMetricRow>(
        `SELECT iata, metric_id AS metricId, value
           FROM metric_values
          WHERE period_id = ?
            AND iata      IN (${codePlaceholders})
            AND metric_id IN (${metricPlaceholders})`,
      )
      .all(periodId, ...codes, ...metricIds);

    return this.Nest(rows);
  }

  public GetAllForPeriod(periodId: string) {
    const rows = this.database
      .Prepare<RawMetricRow>(
        'SELECT iata, metric_id AS metricId, value FROM metric_values WHERE period_id = ?',
      )
      .all(periodId);

    return this.Nest(rows);
  }

  /**
   * Replaces a period's values wholesale.
   *
   * Deleting first matters: if a metric is removed from the registry, an
   * upsert would leave its stale values behind and they would keep feeding
   * into scores long after the metric was retired.
   */
  public Replace(rows: MetricValueRow[], periodId: string) {
    const remove = this.database.Prepare<unknown>('DELETE FROM metric_values WHERE period_id = ?');
    const insert = this.database.Prepare<unknown>(
      `INSERT INTO metric_values (iata, metric_id, period_id, value, sample_size)
       VALUES (@iata, @metricId, @periodId, @value, @sampleSize)
       ON CONFLICT(iata, metric_id, period_id) DO UPDATE SET
         value       = excluded.value,
         sample_size = excluded.sample_size`,
    );

    this.database.Transaction(() => {
      remove.run(periodId);
      for (const row of rows) {
        insert.run({
          iata: row.iata,
          metricId: row.metricId,
          periodId,
          value: row.value,
          sampleSize: row.sampleSize,
        });
      }
    });
  }

  /** metric id -> airport code -> value. Nested keying prevents positional misalignment. */
  private Nest(rows: RawMetricRow[]) {
    return rows.reduce((accumulator: MetricValuesByMetricAndAirport, row) => {
      const existing = accumulator[row.metricId];
      if (existing) existing[row.iata] = row.value;
      else accumulator[row.metricId] = { [row.iata]: row.value };
      return accumulator;
    }, {});
  }
}
