import { CreateIngestContainer } from '../Container/CreateIngestContainer';
import type { IngestContext } from '../Types/Ports/IngestSources';

/**
 * Builds the snapshot from public sources.
 *
 *   npm run ingest
 *   npm run ingest -- --from 2025-07 --to 2026-06
 *   npm run ingest -- --only our_airports,t100_socrata
 *   npm run ingest -- --only bts_otp --from 2026-06 --to 2026-06
 *
 * Defaults to a 12-month On-Time Performance window. Congestion metrics do
 * not need a decade of history, and each month is ~275MB uncompressed, so a
 * wider window buys little for a lot of download time. T-100 always loads its
 * full retained history regardless, because growth metrics do need the depth.
 */

const DefaultOtpFrom = '2025-07';
const DefaultOtpTo = '2026-06';

interface ParsedArguments {
  otpFrom: string;
  otpTo: string;
  onlySourceIds: string[];
  continueOnError: boolean;
}

function ParseArguments(argv: string[]) {
  const flags = argv.reduce((accumulator: FlagValues, token, index) => {
    if (!token.startsWith('--')) return accumulator;
    const name = token.slice(2);
    const next = argv[index + 1];
    accumulator[name] = next && !next.startsWith('--') ? next : 'true';
    return accumulator;
  }, {});

  const parsed: ParsedArguments = {
    otpFrom: flags.from ?? DefaultOtpFrom,
    otpTo: flags.to ?? DefaultOtpTo,
    onlySourceIds: flags.only ? flags.only.split(',').map((value) => value.trim()) : [],
    continueOnError: flags['fail-fast'] !== 'true',
  };
  return parsed;
}

interface FlagValues {
  [name: string]: string;
}

async function Main() {
  const args = ParseArguments(process.argv.slice(2));
  const container = CreateIngestContainer({ onlySourceIds: args.onlySourceIds });

  container.logger.Info('Starting ingest', {
    otpWindow: `${args.otpFrom}..${args.otpTo}`,
    sources: container.sources.map((source) => source.sourceId).join(', ') || '(none matched)',
  });

  const context: IngestContext = {
    otpFrom: args.otpFrom,
    otpTo: args.otpTo,
    continueOnError: args.continueOnError,
  };

  const startedAt = Date.now();
  const outcomes = await container.orchestrator.RunAll(context);

  container.logger.Info('--- summary ---');
  for (const outcome of outcomes) {
    container.logger.Info(outcome.sourceId, {
      rows: outcome.rowsWritten,
      through: outcome.coverageThrough,
      warnings: outcome.warnings.length,
    });
  }

  container.database.Vacuum();
  container.database.Close();

  container.logger.Info('Ingest complete', { seconds: Math.round((Date.now() - startedAt) / 1000) });
}

Main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`\nIngest failed:\n${message}\n`);
  process.exit(1);
});
