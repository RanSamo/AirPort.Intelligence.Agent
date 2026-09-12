import { AllMetricIds, MetricsById } from '../Metrics/MetricRegistry';
import { LoadScoringConfig } from '../Config/LoadScoringConfig';
import type { ScoredPillarId } from '../Types/Scoring/Pillar';

/**
 * Checks that the scoring config and the metric registry agree.
 *
 * These two drift apart easily: removing a metric from the registry leaves
 * orphan weights in the config, and adding one leaves it silently unweighted
 * in some profiles. Either produces plausible-looking but wrong scores, so it
 * is checked rather than assumed.
 *
 *   npm run validate:config
 */

const ScoredPillars: ScoredPillarId[] = ['constraint', 'latent_demand', 'monetization'];

function Main() {
  const { config, scoreVersion } = LoadScoringConfig();

  process.stdout.write(`scoreVersion : ${scoreVersion}\n`);
  process.stdout.write(`aggregation  : ${config.aggregation} (default profile: ${config.defaultProfile})\n`);
  process.stdout.write(`metrics      : ${AllMetricIds.length}\n\n`);

  for (const pillar of ScoredPillars) {
    const ids = AllMetricIds.filter((metricId) => MetricsById[metricId].pillar === pillar);
    process.stdout.write(`  ${pillar.padEnd(15)} ${String(ids.length).padStart(2)}  ${ids.join(', ')}\n`);
  }

  const problems: string[] = [];

  for (const [profileId, profile] of Object.entries(config.profiles)) {
    for (const metricId of Object.keys(profile.metricWeights)) {
      if (!MetricsById[metricId]) {
        problems.push(`profile "${profileId}" weights removed metric "${metricId}"`);
      }
    }
    for (const metricId of AllMetricIds) {
      if (profile.metricWeights[metricId] === undefined) {
        problems.push(`profile "${profileId}" has no weight for "${metricId}"`);
      }
    }
  }

  process.stdout.write('\n--- alignment ---\n');
  if (problems.length === 0) {
    process.stdout.write('  registry and config agree: no orphan weights, no unweighted metrics\n');
  } else {
    for (const problem of problems) process.stdout.write(`  PROBLEM: ${problem}\n`);
    process.exitCode = 1;
  }

  process.stdout.write('\n--- provenance mix ---\n');
  const byProvenance = AllMetricIds.reduce((accumulator: ProvenanceCounts, metricId) => {
    const provenance = MetricsById[metricId].provenance;
    accumulator[provenance] = (accumulator[provenance] ?? 0) + 1;
    return accumulator;
  }, {});
  for (const [provenance, count] of Object.entries(byProvenance)) {
    process.stdout.write(`  ${provenance.padEnd(10)} ${count}\n`);
  }
}

interface ProvenanceCounts {
  [provenance: string]: number;
}

Main();
