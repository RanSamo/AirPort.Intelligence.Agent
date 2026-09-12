import type { MonthKey } from '../Domain/Period';
import type { DataSourceId, DataVersion } from './Source';

/**
 * Metadata describing a built snapshot.
 *
 * Stored in the SQLite file itself so that any consumer — CLI, server, tests —
 * can report exactly what data it is answering from without re-deriving it.
 */

export interface SourceCoverageRecord {
  sourceId: DataSourceId;
  /** Newest period actually present in the snapshot for this source. */
  coverageThrough: string;
  rowCount: number;
  fetchedAt: string;
}

export interface SourceCoverageById {
  [sourceId: string]: SourceCoverageRecord;
}

export interface SnapshotMeta {
  dataVersion: DataVersion;
  /** Hash of the scoring config, so a weight change invalidates cached scores. */
  scoreVersion: string;
  /** dataVersion.hash + scoreVersion. The cache key component. */
  configVersion: string;
  airportCount: number;
  otpReportingAirportCount: number;
  curatedGateCount: number;
  otpWindow: { from: MonthKey; to: MonthKey };
  trafficWindow: { from: MonthKey; to: MonthKey };
  sources: SourceCoverageById;
}
