import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * Thin wrapper over better-sqlite3.
 *
 * better-sqlite3 is synchronous by design, which is the right trade here:
 * the snapshot is a few MB of local file, queries are sub-millisecond, and
 * synchronous access removes a whole class of async plumbing from the
 * repositories and the scoring engine.
 */
export class SqliteConnection {
  private readonly database: Database.Database;

  constructor(filePath: string, options: { readonly?: boolean } = {}) {
    if (!options.readonly) mkdirSync(dirname(filePath), { recursive: true });

    this.database = new Database(filePath, { readonly: options.readonly ?? false });
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
  }

  /** Creates every table and index if absent. Idempotent. */
  public ApplySchema() {
    const schemaPath = join(moduleDirectory, 'Schema.sql');
    this.database.exec(readFileSync(schemaPath, 'utf8'));
    this.ApplyColumnMigrations();
  }

  /**
   * Adds columns introduced after a snapshot was first built.
   *
   * CREATE TABLE IF NOT EXISTS silently does nothing when the table already
   * exists, so new columns would never appear on an existing snapshot. This
   * lets a column be added without discarding an OTP ingest that took 24
   * minutes to build.
   */
  private ApplyColumnMigrations() {
    this.EnsureColumn('traffic_months', 'domestic_departures', 'INTEGER NOT NULL DEFAULT 0');
    this.EnsureColumn('traffic_months', 'domestic_seats', 'INTEGER NOT NULL DEFAULT 0');
    this.EnsureColumn('traffic_months', 'passenger_miles_avg', 'REAL NOT NULL DEFAULT 0');
    // Metro areas resolve to explicit airport lists rather than state sets.
    this.EnsureColumn('regions', 'airport_codes', "TEXT NOT NULL DEFAULT '[]'");
  }

  public EnsureColumn(table: string, column: string, definition: string) {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
    const alreadyPresent = columns.some((entry) => entry.name === column);
    if (alreadyPresent) return;
    this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  public Raw() {
    return this.database;
  }

  public Prepare<TRow>(sql: string) {
    return this.database.prepare(sql) as Database.Statement<unknown[], TRow>;
  }

  public Exec(sql: string) {
    this.database.exec(sql);
  }

  /**
   * Runs work inside a single transaction. Ingest writes tens of thousands
   * of rows; without this each insert would be its own fsync and the build
   * would take hours instead of minutes.
   */
  public Transaction<TResult>(work: () => TResult) {
    const wrapped = this.database.transaction(work);
    return wrapped() as TResult;
  }

  /** Reclaims space and compacts the file before it is committed to git. */
  public Vacuum() {
    this.database.exec('VACUUM');
  }

  public Close() {
    this.database.close();
  }
}

interface ColumnInfo {
  name: string;
}
