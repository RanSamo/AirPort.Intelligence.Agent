import type {
  IIngestOrchestrator,
  IIngestSource,
  IngestContext,
  IngestOutcome,
} from '../Types/Ports/IngestSources';
import type { ILogger } from '../Types/Ports/Logger';

/**
 * Runs ingest sources in dependency order.
 *
 * Sources are injected, so adding one never means editing this class. Order
 * matters: OurAirports seeds the airport table, T-100 fills in traffic and
 * hub class, OTP aggregates congestion, curated facilities load last.
 */
export class IngestOrchestrator implements IIngestOrchestrator {
  private readonly sources: IIngestSource[];
  private readonly logger: ILogger;

  constructor(sources: IIngestSource[], logger: ILogger) {
    // Sorted once at construction so run order never depends on registration order.
    this.sources = [...sources].sort((left, right) => left.order - right.order);
    this.logger = logger;
  }

  public async RunAll(context: IngestContext) {
    const outcomes: IngestOutcome[] = [];

    for (const source of this.sources) {
      this.logger.Info(`--- ${source.label} ---`);
      try {
        const outcome = await source.Run(context);
        outcomes.push(outcome);

        this.logger.Info('done', {
          rows: outcome.rowsWritten,
          through: outcome.coverageThrough,
          seconds: Math.round(outcome.durationMs / 1000),
        });
        for (const warning of outcome.warnings) this.logger.Warn(warning);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.Error(`${source.label} failed`, { message });

        if (!context.continueOnError) throw error;

        outcomes.push({
          sourceId: source.sourceId,
          rowsWritten: 0,
          coverageThrough: '',
          durationMs: 0,
          warnings: [`FAILED: ${message}`],
        });
      }
    }

    return outcomes;
  }
}
