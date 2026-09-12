import type { DataSourceId } from '../Data/Source';

/**
 * Ingest ports.
 *
 * Each source knows how to fetch and normalize exactly one upstream dataset,
 * and reports what it wrote. The orchestrator receives them injected, so
 * adding a source never means editing the orchestrator.
 */

export interface IngestOutcome {
  sourceId: DataSourceId;
  rowsWritten: number;
  /** Newest period present after this run, e.g. "2026-06". */
  coverageThrough: string;
  durationMs: number;
  warnings: string[];
}

export interface IngestContext {
  /** Inclusive month bounds for windowed sources such as OTP. */
  otpFrom: string;
  otpTo: string;
  /** Set false to fail loudly instead of skipping a source that errors. */
  continueOnError: boolean;
}

export interface IIngestSource {
  readonly sourceId: DataSourceId;
  readonly label: string;
  /** Sources with a lower order run first; later sources may depend on earlier ones. */
  readonly order: number;
  Run(context: IngestContext): Promise<IngestOutcome>;
}

export interface IIngestOrchestrator {
  RunAll(context: IngestContext): Promise<IngestOutcome[]>;
}
