import { SnapshotDatabasePath } from '../Config/Paths';
import { SqliteConnection } from '../Infrastructure/Database/SqliteConnection';

/**
 * Audits every derived quantity for domestic/total unit mixing.
 *
 * BTS On-Time Performance is domestic-only while T-100 covers all traffic, so
 * any metric that combines the two must use the domestic halves of both. This
 * script recomputes each candidate quantity both ways and reports where the
 * difference is material, so the mixing defect cannot reappear unnoticed.
 *
 *   npm run validate:domestic
 */

const MaterialThresholdPercent = 5;

interface AuditRow {
  iata: string;
  name: string;
  totalDepartures: number;
  domesticDepartures: number;
  seatsPerDepTotal: number;
  seatsPerDepDomestic: number;
  loadFactorTotal: number;
  loadFactorDomestic: number;
  paxPerDepTotal: number;
  paxPerDepDomestic: number;
  internationalSharePct: number;
}

function PercentDelta(mixed: number, correct: number) {
  if (correct === 0) return 0;
  return ((mixed - correct) / correct) * 100;
}

function Format(value: number, width: number, decimals = 1) {
  return value.toFixed(decimals).padStart(width);
}

function Main() {
  const database = new SqliteConnection(SnapshotDatabasePath, { readonly: true });

  const latestMonth =
    database.Prepare<{ m: string }>('SELECT MAX(month_key) AS m FROM traffic_months').get()?.m ?? '';

  const rows = database
    .Prepare<AuditRow>(
      `SELECT t.iata,
              a.name                                                          AS name,
              t.departures                                                    AS totalDepartures,
              t.domestic_departures                                           AS domesticDepartures,
              CAST(t.seats AS REAL)          / NULLIF(t.departures, 0)         AS seatsPerDepTotal,
              CAST(t.domestic_seats AS REAL) / NULLIF(t.domestic_departures,0) AS seatsPerDepDomestic,
              CAST(t.passengers AS REAL)     / NULLIF(t.seats, 0)              AS loadFactorTotal,
              CAST(t.domestic_passengers AS REAL) / NULLIF(t.domestic_seats,0) AS loadFactorDomestic,
              CAST(t.passengers AS REAL)     / NULLIF(t.departures, 0)         AS paxPerDepTotal,
              CAST(t.domestic_passengers AS REAL) / NULLIF(t.domestic_departures,0) AS paxPerDepDomestic,
              100.0 * t.international_passengers / NULLIF(t.passengers, 0)     AS internationalSharePct
         FROM traffic_months t
         JOIN airports a ON a.iata = t.iata
        WHERE t.month_key = ?
          AND t.domestic_departures > 0
          AND t.departures > 500
     ORDER BY t.passengers DESC
        LIMIT 20`,
    )
    .all(latestMonth);

  process.stdout.write(`Domestic/total consistency audit - ${latestMonth}\n\n`);
  process.stdout.write('                    seats per dep        load factor        pax per dep\n');
  process.stdout.write('code  intl%   total   dom    err    total   dom    err    total   dom    err\n');

  const worst = { seats: 0, loadFactor: 0, paxPerDep: 0 };

  for (const row of rows) {
    const seatsErr = PercentDelta(row.seatsPerDepTotal, row.seatsPerDepDomestic);
    const loadErr = PercentDelta(row.loadFactorTotal, row.loadFactorDomestic);
    const paxErr = PercentDelta(row.paxPerDepTotal, row.paxPerDepDomestic);

    worst.seats = Math.max(worst.seats, Math.abs(seatsErr));
    worst.loadFactor = Math.max(worst.loadFactor, Math.abs(loadErr));
    worst.paxPerDep = Math.max(worst.paxPerDep, Math.abs(paxErr));

    process.stdout.write(
      `${row.iata.padEnd(5)}${Format(row.internationalSharePct, 5)}  ` +
        `${Format(row.seatsPerDepTotal, 6)}${Format(row.seatsPerDepDomestic, 6)}${Format(seatsErr, 7)}  ` +
        `${Format(row.loadFactorTotal * 100, 7)}${Format(row.loadFactorDomestic * 100, 6)}${Format(loadErr, 7)}  ` +
        `${Format(row.paxPerDepTotal, 7)}${Format(row.paxPerDepDomestic, 6)}${Format(paxErr, 7)}\n`,
    );
  }

  process.stdout.write('\n--- verdict (max absolute error across sample) ---\n');
  const verdicts = [
    { label: 'seats per departure  (seats_per_departure_trend)', error: worst.seats },
    { label: 'load factor          (avg_load_factor, spill)   ', error: worst.loadFactor },
    { label: 'passengers per dep   (peak_hour_passengers)     ', error: worst.paxPerDep },
  ];

  for (const verdict of verdicts) {
    const flag = verdict.error >= MaterialThresholdPercent ? 'MATERIAL -> must use domestic' : 'immaterial -> total is safe';
    process.stdout.write(`  ${verdict.label}  ${verdict.error.toFixed(1).padStart(6)}%   ${flag}\n`);
  }

  database.Close();
}

Main();
