import { SnapshotDatabasePath } from '../Config/Paths';
import { SqliteConnection } from '../Infrastructure/Database/SqliteConnection';

/**
 * Prints a readable slice of the snapshot for eyeballing after ingest.
 *
 *   npm run inspect
 *   npm run inspect -- --month 2026-06 --airports SFO,LAX,JFK
 *
 * A scoring engine that silently reads wrong numbers is the worst failure
 * mode in this project, so the underlying facts get looked at directly.
 */

const DefaultAirports = ['ATL', 'ORD', 'LAX', 'JFK', 'SFO', 'BOS', 'SNA', 'ANC', 'DJT'];

interface CongestionRow {
  iata: string;
  name: string;
  flights: number;
  taxiOutP50: number;
  taxiOutP90: number;
  pctDelayed15: number;
  nasSharePct: number;
  peakHourDepartures: number;
}

interface HaulRow {
  iata: string;
  shortPct: number;
  mediumPct: number;
  longPct: number;
  total: number;
}

interface TrafficRow {
  iata: string;
  passengers: number;
  seats: number;
  loadFactor: number;
  internationalPct: number;
  domesticDepartures: number;
  passengerMilesAvg: number;
}

interface FlagValues {
  [name: string]: string;
}

function ParseArguments(argv: string[]) {
  return argv.reduce((accumulator: FlagValues, token, index) => {
    if (!token.startsWith('--')) return accumulator;
    const next = argv[index + 1];
    accumulator[token.slice(2)] = next && !next.startsWith('--') ? next : 'true';
    return accumulator;
  }, {});
}

function BuildPlaceholders(count: number) {
  return new Array(count).fill('?').join(',');
}

function Main() {
  const flags = ParseArguments(process.argv.slice(2));
  const database = new SqliteConnection(SnapshotDatabasePath, { readonly: true });

  const airports = flags.airports ? flags.airports.split(',').map((code) => code.trim().toUpperCase()) : DefaultAirports;
  const placeholders = BuildPlaceholders(airports.length);

  const latestCongestionMonth =
    flags.month ??
    database.Prepare<{ m: string }>('SELECT MAX(month_key) AS m FROM congestion_months').get()?.m ??
    '';
  const latestTrafficMonth =
    database.Prepare<{ m: string }>('SELECT MAX(month_key) AS m FROM traffic_months').get()?.m ?? '';

  process.stdout.write(`Snapshot: ${SnapshotDatabasePath}\n`);
  process.stdout.write(`Congestion latest month: ${latestCongestionMonth || '(none ingested)'}\n`);
  process.stdout.write(`Traffic latest month   : ${latestTrafficMonth || '(none ingested)'}\n\n`);

  PrintCounts(database);

  if (latestCongestionMonth) {
    const congestion = database
      .Prepare<CongestionRow>(
        `SELECT c.iata,
                a.name                                              AS name,
                c.flights                                           AS flights,
                c.taxi_out_p50                                      AS taxiOutP50,
                c.taxi_out_p90                                      AS taxiOutP90,
                ROUND(100.0 * c.departures_delayed_15 / NULLIF(c.flights, 0), 1) AS pctDelayed15,
                ROUND(100.0 * c.nas_delay_minutes / NULLIF(
                  c.nas_delay_minutes + c.weather_delay_minutes + c.carrier_delay_minutes +
                  c.late_aircraft_delay_minutes + c.security_delay_minutes, 0), 1)  AS nasSharePct,
                c.peak_hour_departures                              AS peakHourDepartures
           FROM congestion_months c
           JOIN airports a ON a.iata = c.iata
          WHERE c.month_key = ? AND c.iata IN (${placeholders})
       ORDER BY c.flights DESC`,
      )
      .all(latestCongestionMonth, ...airports);

    process.stdout.write(`--- Congestion (${latestCongestionMonth}) ---\n`);
    process.stdout.write('code   flights  taxiP50  taxiP90  %del15   NAS%   peak  name\n');
    for (const row of congestion) {
      process.stdout.write(
        `${row.iata.padEnd(5)} ${String(row.flights).padStart(8)} ${String(row.taxiOutP50).padStart(8)}` +
          ` ${String(row.taxiOutP90).padStart(8)} ${String(row.pctDelayed15).padStart(7)}` +
          ` ${String(row.nasSharePct).padStart(6)} ${String(row.peakHourDepartures).padStart(6)}  ${row.name.slice(0, 38)}\n`,
      );
    }

    const haul = database
      .Prepare<HaulRow>(
        `SELECT iata,
                ROUND(100.0 * short_haul_flights  / NULLIF(total_flights, 0), 1) AS shortPct,
                ROUND(100.0 * medium_haul_flights / NULLIF(total_flights, 0), 1) AS mediumPct,
                ROUND(100.0 * long_haul_flights   / NULLIF(total_flights, 0), 1) AS longPct,
                total_flights AS total
           FROM haul_mix_months
          WHERE month_key = ? AND iata IN (${placeholders})
       ORDER BY total DESC`,
      )
      .all(latestCongestionMonth, ...airports);

    process.stdout.write(`\n--- Haul mix (${latestCongestionMonth}) ---\n`);
    process.stdout.write('code   short%  medium%   long%  flights\n');
    for (const row of haul) {
      process.stdout.write(
        `${row.iata.padEnd(5)} ${String(row.shortPct).padStart(7)} ${String(row.mediumPct).padStart(8)}` +
          ` ${String(row.longPct).padStart(7)} ${String(row.total).padStart(8)}\n`,
      );
    }
  }

  if (latestTrafficMonth) {
    const traffic = database
      .Prepare<TrafficRow>(
        `SELECT iata,
                passengers,
                seats,
                ROUND(load_factor * 100, 1) AS loadFactor,
                ROUND(100.0 * international_passengers / NULLIF(passengers, 0), 1) AS internationalPct,
                domestic_departures AS domesticDepartures,
                ROUND(passenger_miles_avg, 0) AS passengerMilesAvg
           FROM traffic_months
          WHERE month_key = ? AND iata IN (${placeholders})
       ORDER BY passengers DESC`,
      )
      .all(latestTrafficMonth, ...airports);

    process.stdout.write(`\n--- Traffic (${latestTrafficMonth}) ---\n`);
    process.stdout.write('code     passengers        seats     LF%   intl%   domDeps   avgPaxMi\n');
    for (const row of traffic) {
      process.stdout.write(
        `${row.iata.padEnd(5)} ${row.passengers.toLocaleString().padStart(12)}` +
          ` ${row.seats.toLocaleString().padStart(12)} ${String(row.loadFactor).padStart(7)}` +
          ` ${String(row.internationalPct).padStart(7)} ${row.domesticDepartures.toLocaleString().padStart(9)}` +
          ` ${row.passengerMilesAvg.toLocaleString().padStart(10)}\n`,
      );
    }
  }

  PrintMetrics(database, airports);
  database.Close();
}

interface MetricCell {
  iata: string;
  metricId: string;
  value: number;
}

/** Computed metric values, so the scoring inputs can be eyeballed directly. */
function PrintMetrics(database: SqliteConnection, airports: string[]) {
  const placeholders = BuildPlaceholders(airports.length);
  const rows = database
    .Prepare<MetricCell>(
      `SELECT iata, metric_id AS metricId, value
         FROM metric_values
        WHERE period_id = 'latest_12m' AND iata IN (${placeholders})`,
    )
    .all(...airports);

  if (rows.length === 0) {
    process.stdout.write('\n--- Metrics --- (none computed yet; run npm run build:metrics)\n');
    return;
  }

  const byMetric = rows.reduce((accumulator: MetricGrid, row) => {
    const existing = accumulator[row.metricId];
    if (existing) existing[row.iata] = row.value;
    else accumulator[row.metricId] = { [row.iata]: row.value };
    return accumulator;
  }, {});

  const present = airports.filter((code) => rows.some((row) => row.iata === code));

  process.stdout.write('\n--- Computed metrics (latest_12m) ---\n');
  process.stdout.write('metric'.padEnd(27) + present.map((code) => code.padStart(9)).join('') + '\n');

  for (const metricId of Object.keys(byMetric).sort()) {
    const cells = present
      .map((code) => {
        const value = byMetric[metricId][code];
        return value === undefined ? '-'.padStart(9) : value.toFixed(3).padStart(9);
      })
      .join('');
    process.stdout.write(metricId.padEnd(27) + cells + '\n');
  }
}

interface MetricGrid {
  [metricId: string]: { [iata: string]: number };
}

function PrintCounts(database: SqliteConnection) {
  const counts = [
    { label: 'airports', sql: 'SELECT COUNT(*) AS n FROM airports' },
    { label: 'airports with traffic', sql: 'SELECT COUNT(DISTINCT iata) AS n FROM traffic_months' },
    { label: 'airports with congestion', sql: 'SELECT COUNT(DISTINCT iata) AS n FROM congestion_months' },
    { label: 'aliases', sql: 'SELECT COUNT(*) AS n FROM airport_aliases' },
    { label: 'traffic rows', sql: 'SELECT COUNT(*) AS n FROM traffic_months' },
    { label: 'congestion rows', sql: 'SELECT COUNT(*) AS n FROM congestion_months' },
  ];

  process.stdout.write('--- Row counts ---\n');
  for (const entry of counts) {
    const value = database.Prepare<{ n: number }>(entry.sql).get()?.n ?? 0;
    process.stdout.write(`  ${entry.label.padEnd(26)} ${value.toLocaleString()}\n`);
  }
  process.stdout.write('\n');
}

Main();
