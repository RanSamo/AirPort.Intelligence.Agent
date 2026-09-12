import { AirportCodeResolver } from '../Ingest/AirportCodeResolver';
import { SnapshotDatabasePath } from '../Config/Paths';
import { SqliteConnection } from '../Infrastructure/Database/SqliteConnection';
import { T100SocrataEndpoint } from '../Config/DataSources';

/**
 * Audits how much of the upstream universe actually made it into the snapshot.
 *
 * The brief asks for every US airport the public data covers, so silently
 * dropping airports during ingest would be a real defect. This compares the
 * snapshot against a live T-100 aggregate and reports what is missing and how
 * much traffic it represents.
 *
 *   npm run verify:coverage
 */

const ReferenceYear = '2025';

interface AggregateRow {
  origin_airport_code?: string;
  pax?: string;
}

interface MissingEntry {
  code: string;
  passengers: number;
}

async function Main() {
  const database = new SqliteConnection(SnapshotDatabasePath, { readonly: true });

  // Must resolve through aliases, not just canonical codes: BTS reports
  // West Palm Beach as PBI while the snapshot stores it as DJT, so a
  // canonical-only check reports a 4.3M-passenger false positive.
  const resolver = AirportCodeResolver.FromDatabase(database);

  const query =
    `${T100SocrataEndpoint.url}?$select=origin_airport_code,sum(total_passengers) as pax` +
    `&$where=${encodeURIComponent(`year = '${ReferenceYear}'`)}` +
    `&$group=origin_airport_code&$order=pax DESC&$limit=2000`;

  const response = await fetch(query);
  const rows = (await response.json()) as AggregateRow[];

  const upstream = rows
    .map((row) => ({ code: (row.origin_airport_code ?? '').trim().toUpperCase(), passengers: Number(row.pax) || 0 }))
    .filter((row) => row.code !== '' && row.passengers > 0);

  const totalPassengers = upstream.reduce((sum, row) => sum + row.passengers, 0);
  const missing = upstream.reduce((accumulator: MissingEntry[], row) => {
    if (!resolver.Resolve(row.code)) accumulator.push({ code: row.code, passengers: row.passengers });
    return accumulator;
  }, []);
  const missingPassengers = missing.reduce((sum, row) => sum + row.passengers, 0);

  process.stdout.write(`T-100 CY${ReferenceYear} airports upstream : ${upstream.length}\n`);
  process.stdout.write(`present in snapshot               : ${upstream.length - missing.length}\n`);
  process.stdout.write(`missing from snapshot             : ${missing.length}\n`);
  process.stdout.write(
    `missing share of US enplanements  : ${((missingPassengers / totalPassengers) * 100).toFixed(3)}%\n`,
  );

  process.stdout.write('\nLargest missing airports:\n');
  for (const entry of missing.slice(0, 25)) {
    const share = ((entry.passengers / totalPassengers) * 100).toFixed(4);
    process.stdout.write(
      `  ${entry.code.padEnd(5)} ${entry.passengers.toLocaleString().padStart(12)}  (${share}%)\n`,
    );
  }

  database.Close();
}

Main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`\nCoverage verification failed:\n${message}\n`);
  process.exit(1);
});
