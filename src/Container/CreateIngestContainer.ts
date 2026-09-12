import { HttpCacheDirectory, SnapshotDatabasePath } from '../Config/Paths';
import { CachedHttpFetcher } from '../Infrastructure/Http/CachedHttpFetcher';
import { ConsoleLogger } from '../Infrastructure/Logging/ConsoleLogger';
import { CuratedDataSource } from '../Ingest/Sources/CuratedDataSource';
import { FileSystemHttpCache } from '../Infrastructure/Http/FileSystemHttpCache';
import { IngestOrchestrator } from '../Ingest/IngestOrchestrator';
import { CsvStreamParser } from '../Ingest/Parsers/CsvStreamParser';
import { OtpBulkSource } from '../Ingest/Sources/OtpBulkSource';
import { OurAirportsSource } from '../Ingest/Sources/OurAirportsSource';
import { SqliteConnection } from '../Infrastructure/Database/SqliteConnection';
import { SystemClock } from '../Infrastructure/Clock/SystemClock';
import { T100SocrataSource } from '../Ingest/Sources/T100SocrataSource';
import { ZipEntryReader } from '../Ingest/Parsers/ZipEntryReader';

import type { IClock } from '../Types/Ports/Clock';
import type { IHttpFetcher } from '../Types/Ports/Fetchers';
import type { IIngestSource } from '../Types/Ports/IngestSources';
import type { ILogger } from '../Types/Ports/Logger';
import type { LogLevel } from '../Infrastructure/Logging/ConsoleLogger';

/**
 * Composition root for ingest.
 *
 * Constructor injection with a plain factory — no decorators, no
 * reflect-metadata, no DI framework. Every dependency is overridable, which
 * is what makes the sources testable against fakes.
 */
export interface IngestDependencies {
  logger: ILogger;
  clock: IClock;
  database: SqliteConnection;
  fetcher: IHttpFetcher;
  /** Restricts the run to these source ids. Empty means run everything. */
  onlySourceIds: string[];
}

export interface IngestContainer {
  logger: ILogger;
  clock: IClock;
  database: SqliteConnection;
  fetcher: IHttpFetcher;
  orchestrator: IngestOrchestrator;
  sources: IIngestSource[];
}

export interface IngestContainerOptions {
  logLevel?: LogLevel;
  databasePath?: string;
  cacheDirectory?: string;
  onlySourceIds?: string[];
  overrides?: Partial<IngestDependencies>;
}

export function CreateIngestContainer(options: IngestContainerOptions = {}) {
  const overrides = options.overrides ?? {};

  const logger = overrides.logger ?? new ConsoleLogger(options.logLevel ?? 'info');
  const clock = overrides.clock ?? new SystemClock();

  const database = overrides.database ?? new SqliteConnection(options.databasePath ?? SnapshotDatabasePath);
  database.ApplySchema();

  const cache = new FileSystemHttpCache(options.cacheDirectory ?? HttpCacheDirectory, clock);
  const fetcher = overrides.fetcher ?? new CachedHttpFetcher(cache, logger);

  const csvParser = new CsvStreamParser();
  const zipReader = new ZipEntryReader();

  const allSources: IIngestSource[] = [
    new OurAirportsSource(fetcher, database, csvParser, logger),
    new T100SocrataSource(fetcher, database, logger),
    new OtpBulkSource(fetcher, database, csvParser, zipReader, logger),
    new CuratedDataSource(database, logger),
  ];

  const onlySourceIds = options.onlySourceIds ?? overrides.onlySourceIds ?? [];
  const sources =
    onlySourceIds.length === 0
      ? allSources
      : allSources.filter((source) => onlySourceIds.includes(source.sourceId));

  const container: IngestContainer = {
    logger,
    clock,
    database,
    fetcher,
    orchestrator: new IngestOrchestrator(sources, logger),
    sources,
  };
  return container;
}
