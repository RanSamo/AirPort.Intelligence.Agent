import { LoadScoringConfig } from '../Config/LoadScoringConfig';
import { MetricComputationService } from '../Metrics/MetricComputationService';
import { ConsoleLogger } from '../Infrastructure/Logging/ConsoleLogger';
import { SnapshotDatabasePath } from '../Config/Paths';
import { SpillModel } from '../Scoring/Spill/SpillModel';
import { SqliteCongestionRepository } from '../Repositories/SqliteCongestionRepository';
import { SqliteConnection } from '../Infrastructure/Database/SqliteConnection';
import { SqliteMetricRepository } from '../Repositories/SqliteMetricRepository';
import { SqliteTrafficRepository } from '../Repositories/SqliteTrafficRepository';
import { AllMetricIds, MetricsById } from '../Metrics/MetricRegistry';

/**
 * Computes the scored metrics from the snapshot and stores them.
 *
 *   npm run build:metrics
 *
 * Separate from ingest so the metrics can be recomputed in seconds after a
 * formula or window change, without re-downloading anything.
 */

interface CountsByMetric {
  [metricId: string]: number;
}

function Main() {
  const logger = new ConsoleLogger('info');
  const { config, scoreVersion } = LoadScoringConfig();

  const database = new SqliteConnection(SnapshotDatabasePath);
  database.ApplySchema();

  const traffic = new SqliteTrafficRepository(database);
  const congestion = new SqliteCongestionRepository(database);
  const metrics = new SqliteMetricRepository(database);
  const spillModel = new SpillModel(config.spill.kFactor);

  const service = new MetricComputationService(traffic, congestion, spillModel, logger);
  const windows = service.ResolveWindows();

  logger.Info('Analysis windows', {
    recent: `${windows.recentFrom}..${windows.recentTo}`,
    prior: `${windows.priorFrom}..${windows.priorTo}`,
    base3y: `${windows.baseFrom}..${windows.baseTo}`,
    congestion: `${windows.congestionFrom}..${windows.congestionTo}`,
  });

  const startedAt = Date.now();
  const computed = service.ComputeAll(windows);
  metrics.Replace(computed, windows.periodId);

  const counts = computed.reduce((accumulator: CountsByMetric, row) => {
    accumulator[row.metricId] = (accumulator[row.metricId] ?? 0) + 1;
    return accumulator;
  }, {});

  process.stdout.write('\n--- airports with a value, by metric ---\n');
  for (const metricId of AllMetricIds) {
    const definition = MetricsById[metricId];
    const count = counts[metricId] ?? 0;
    const flag = count === 0 ? '  <-- NO VALUES' : '';
    process.stdout.write(
      `  ${metricId.padEnd(26)} ${String(count).padStart(5)}  (${definition.pillar}, ${definition.provenance})${flag}\n`,
    );
  }

  logger.Info('Metrics stored', {
    values: computed.length,
    periodId: windows.periodId,
    scoreVersion,
    seconds: Math.round((Date.now() - startedAt) / 1000),
  });

  database.Close();
}

Main();
