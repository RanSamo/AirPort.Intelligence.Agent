import { CreateScoringContainer } from '../Container/CreateScoringContainer';
import type { AggregationMode, ScaleWeighting, ScoreProfileId } from '../Types/Scoring/ScoringConfig';
import type { Airport } from '../Types/Domain/Airport';

/**
 * Ranks airports from the command line — the deterministic engine with no
 * language model anywhere in the path.
 *
 *   npm run rank
 *   npm run rank -- --region new_england --profile terminal
 *   npm run rank -- --region new_england --profile terminal --aggregation arithmetic
 *   npm run rank -- --airports LAX,SNA,BUR,LGB,ONT --profile airfield
 *   npm run rank -- --state CA --top 10 --explain
 */

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

function Main() {
  const flags = ParseArguments(process.argv.slice(2));
  const container = CreateScoringContainer({ logLevel: 'warn' });

  const profile = (flags.profile ?? container.config.defaultProfile) as ScoreProfileId;
  const aggregation = (flags.aggregation ?? container.config.aggregation) as AggregationMode;
  const scaleWeighting = (flags.scale ?? container.config.scale.weighting) as ScaleWeighting;
  const topN = flags.top ? Number(flags.top) : 15;

  const airports = ResolveAirports(container, flags);
  if (airports.length === 0) {
    process.stdout.write('No airports matched that filter.\n');
    container.database.Close();
    return;
  }

  const result = container.scoringEngine.Rank({
    airports,
    periodId: 'latest_12m',
    overrides: { profile, aggregation, scaleWeighting },
    topN,
  });

  const profileLabel = container.config.profiles[profile]?.label ?? profile;
  process.stdout.write(
    `\nProfile: ${profileLabel}   Aggregation: ${aggregation}   Materiality: ${scaleWeighting}\n`,
  );
  process.stdout.write(`Considered ${result.consideredCount} airports, ranked ${result.scores.length}.\n\n`);

  process.stdout.write('  #  code  score   need  payoff   feas  scale     cohort  conf   cov   name\n');
  for (const score of result.scores) {
    process.stdout.write(
      `${String(score.rank).padStart(3)}  ${score.iata.padEnd(5)}` +
        `${score.score.toFixed(1).padStart(6)} ${score.need.toFixed(1).padStart(6)} ${score.payoff.toFixed(1).padStart(7)}` +
        `${score.feasibilityMultiplier.toFixed(2).padStart(7)}${score.scaleMultiplier.toFixed(2).padStart(7)}` +
        `${(score.hubClass + ' p' + score.cohortPercentile.toFixed(0)).padStart(11)}` +
        `${score.confidence.padStart(7)}${(score.coverage * 100).toFixed(0).padStart(5)}%  ${score.airportName.slice(0, 32)}\n`,
    );
  }

  if (result.exclusions.length > 0) {
    process.stdout.write(`\n--- Excluded (${result.exclusions.length}) ---\n`);
    for (const exclusion of result.exclusions.slice(0, 5)) {
      process.stdout.write(`  ${exclusion.iata}: ${exclusion.explanation}\n`);
    }
    if (result.exclusions.length > 5) {
      process.stdout.write(`  ...and ${result.exclusions.length - 5} more.\n`);
    }
  }

  if (flags.sensitivity === 'true' && result.scores.length > 0) {
    const startedAt = Date.now();
    const sensitivity = container.sensitivityAnalyzer.Analyze({
      airports,
      periodId: 'latest_12m',
      overrides: { profile, aggregation, scaleWeighting },
    });

    process.stdout.write(
      `\n--- Weight sensitivity (${sensitivity.draws} resampled weightings, ${Date.now() - startedAt}ms) ---\n`,
    );
    process.stdout.write('code   baseline  median  range     P(top5)  P(holds rank)\n');
    for (const entry of sensitivity.distributions.slice(0, topN)) {
      process.stdout.write(
        `${entry.iata.padEnd(6)}${String(entry.baselineRank).padStart(8)}` +
          `${String(entry.medianRank).padStart(8)}` +
          `${`${entry.bestRank}-${entry.worstRank}`.padStart(8)}` +
          `${`${(entry.probabilityInTopN * 100).toFixed(0)}%`.padStart(10)}` +
          `${`${(entry.probabilityAtBaselineRank * 100).toFixed(0)}%`.padStart(15)}\n`,
      );
    }
    process.stdout.write(`\n  ${sensitivity.narrative}\n`);
  }

  if (flags.explain === 'true' && result.scores.length > 0) {
    const top = result.scores[0];
    process.stdout.write(`\n--- Why ${top.iata} scores ${top.score.toFixed(1)} ---\n`);
    for (const term of top.waterfall.terms) {
      const sign = term.kind === 'baseline' ? ' ' : term.amount >= 0 ? '+' : '-';
      const magnitude = term.kind === 'baseline' ? term.amount : Math.abs(term.amount);
      process.stdout.write(
        `  ${sign}${magnitude.toFixed(1).padStart(6)}  -> ${term.runningTotal.toFixed(1).padStart(6)}  ${term.label}\n` +
          `            ${term.narrative}\n`,
      );
    }
    process.stdout.write(`  ${'='.repeat(60)}\n  total ${top.waterfall.total.toFixed(1)}\n`);
  }

  container.database.Close();
}

function ResolveAirports(container: ReturnType<typeof CreateScoringContainer>, flags: FlagValues) {
  if (flags.airports) {
    const codes = flags.airports.split(',').map((code) => code.trim().toUpperCase());
    return Object.values(container.airportRepository.GetManyByCode(codes));
  }

  const filter: { regionId?: string; states?: string[]; requiresOnTimeReporting?: boolean } = {};
  if (flags.region) filter.regionId = flags.region;
  if (flags.state) filter.states = [flags.state.toUpperCase()];

  const found: Airport[] = container.airportRepository.Find(filter);
  return found;
}

Main();
