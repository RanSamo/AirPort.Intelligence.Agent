import { AggregatorFactory } from '../Scoring/Aggregators/AggregatorFactory';
import { ArithmeticAggregator } from '../Scoring/Aggregators/ArithmeticAggregator';
import { ConsoleLogger } from '../Infrastructure/Logging/ConsoleLogger';
import { CoverageEvaluator } from '../Scoring/Coverage/CoverageEvaluator';
import { FeasibilityAdjuster } from '../Scoring/Feasibility/FeasibilityAdjuster';
import { GeometricAggregator } from '../Scoring/Aggregators/GeometricAggregator';
import { LoadScoringConfig } from '../Config/LoadScoringConfig';
import { PillarCalculator } from '../Scoring/Pillars/PillarCalculator';
import { RobustZNormalizer } from '../Scoring/Normalizers/RobustZNormalizer';
import { ScaleAdjuster } from '../Scoring/Scale/ScaleAdjuster';
import { ScoringEngine } from '../Scoring/ScoringEngine';
import { SensitivityAnalyzer } from '../Scoring/Sensitivity/SensitivityAnalyzer';
import { SnapshotDatabasePath } from '../Config/Paths';
import { SpillModel } from '../Scoring/Spill/SpillModel';
import { SqliteAirportRepository } from '../Repositories/SqliteAirportRepository';
import { SqliteCongestionRepository } from '../Repositories/SqliteCongestionRepository';
import { SqliteConnection } from '../Infrastructure/Database/SqliteConnection';
import { SqliteFacilityRepository } from '../Repositories/SqliteFacilityRepository';
import { SqliteMetricRepository } from '../Repositories/SqliteMetricRepository';
import { SqliteTrafficRepository } from '../Repositories/SqliteTrafficRepository';
import { WaterfallBuilder } from '../Scoring/Explain/WaterfallBuilder';

import type { ILogger } from '../Types/Ports/Logger';
import type { LogLevel } from '../Infrastructure/Logging/ConsoleLogger';
import type { ScoringConfig } from '../Types/Scoring/ScoringConfig';

/**
 * Composition root for the scoring stack.
 *
 * Plain constructor injection with a factory — no decorators, no
 * reflect-metadata, no container library. Every dependency is overridable,
 * which is what lets tests swap in an in-memory repository with fixtures and
 * assert the scoring maths without touching SQLite.
 */
export interface ScoringDependencies {
  logger: ILogger;
  database: SqliteConnection;
  airportRepository: SqliteAirportRepository;
  metricRepository: SqliteMetricRepository;
  facilityRepository: SqliteFacilityRepository;
  trafficRepository: SqliteTrafficRepository;
  congestionRepository: SqliteCongestionRepository;
}

export interface ScoringContainer extends ScoringDependencies {
  config: ScoringConfig;
  scoreVersion: string;
  spillModel: SpillModel;
  scoringEngine: ScoringEngine;
  sensitivityAnalyzer: SensitivityAnalyzer;
}

export interface ScoringContainerOptions {
  logLevel?: LogLevel;
  databasePath?: string;
  readonly?: boolean;
  overrides?: Partial<ScoringDependencies>;
}

export function CreateScoringContainer(options: ScoringContainerOptions = {}) {
  const overrides = options.overrides ?? {};

  const logger = overrides.logger ?? new ConsoleLogger(options.logLevel ?? 'info');
  const { config, scoreVersion } = LoadScoringConfig();

  const database =
    overrides.database ??
    new SqliteConnection(options.databasePath ?? SnapshotDatabasePath, { readonly: options.readonly ?? true });

  const airportRepository = overrides.airportRepository ?? new SqliteAirportRepository(database);
  const metricRepository = overrides.metricRepository ?? new SqliteMetricRepository(database);
  const facilityRepository = overrides.facilityRepository ?? new SqliteFacilityRepository(database);
  const trafficRepository = overrides.trafficRepository ?? new SqliteTrafficRepository(database);
  const congestionRepository = overrides.congestionRepository ?? new SqliteCongestionRepository(database);

  const normalizer = new RobustZNormalizer(config);
  const aggregatorFactory = new AggregatorFactory(new GeometricAggregator(), new ArithmeticAggregator());

  const scoringEngine = new ScoringEngine(
    airportRepository,
    metricRepository,
    normalizer,
    new PillarCalculator(),
    new CoverageEvaluator(config),
    aggregatorFactory,
    new FeasibilityAdjuster(facilityRepository),
    new ScaleAdjuster(config.scale),
    new WaterfallBuilder(),
    config,
  );

  const container: ScoringContainer = {
    logger,
    database,
    airportRepository,
    metricRepository,
    facilityRepository,
    trafficRepository,
    congestionRepository,
    config,
    scoreVersion,
    spillModel: new SpillModel(config.spill.kFactor),
    scoringEngine,
    sensitivityAnalyzer: new SensitivityAnalyzer(scoringEngine, config),
  };
  return container;
}
