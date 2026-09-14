import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ScoringConfig } from '../Types/Scoring/ScoringConfig';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const ConfigPath = join(moduleDirectory, 'ScoringConfig.json');

/** Tolerance for weight sums that must equal 1, allowing for float noise. */
const SumTolerance = 1e-6;

export class InvalidScoringConfigError extends Error {
  constructor(message: string) {
    super(`Invalid ScoringConfig.json: ${message}`);
    this.name = 'InvalidScoringConfigError';
  }
}

export interface LoadedScoringConfig {
  config: ScoringConfig;
  /** Hash of the effective config. Feeds configVersion, which keys every cache. */
  scoreVersion: string;
}

/**
 * Loads and validates the scoring configuration.
 *
 * Validation is strict and fails loudly. A weight vector that silently does
 * not sum to 1 would skew every score in the system while still producing
 * plausible-looking numbers, which is the hardest kind of bug to notice.
 */
export function LoadScoringConfig(path: string = ConfigPath) {
  const raw = readFileSync(path, 'utf8');
  const config = JSON.parse(raw) as ScoringConfig;

  Validate(config);

  const loaded: LoadedScoringConfig = {
    config,
    scoreVersion: HashConfig(config),
  };
  return loaded;
}

function Validate(config: ScoringConfig) {
  if (!config.version) throw new InvalidScoringConfigError('missing "version"');

  if (config.aggregation !== 'geometric' && config.aggregation !== 'arithmetic') {
    throw new InvalidScoringConfigError(`aggregation must be "geometric" or "arithmetic", got "${config.aggregation}"`);
  }

  AssertSumsToOne(
    config.needComposition.constraint + config.needComposition.latentDemand,
    'needComposition',
  );
  AssertSumsToOne(
    config.geometricExponents.need + config.geometricExponents.payoff,
    'geometricExponents',
  );

  const profile = config.profiles[config.defaultProfile];
  if (!profile) {
    throw new InvalidScoringConfigError(`defaultProfile "${config.defaultProfile}" is not defined in "profiles"`);
  }

  for (const [profileId, profileConfig] of Object.entries(config.profiles)) {
    AssertSumsToOne(
      profileConfig.needComposition.constraint + profileConfig.needComposition.latentDemand,
      `profiles.${profileId}.needComposition`,
    );

    for (const [metricId, weight] of Object.entries(profileConfig.metricWeights)) {
      if (!Number.isFinite(weight) || weight < 0) {
        throw new InvalidScoringConfigError(`profiles.${profileId}.metricWeights.${metricId} must be a non-negative number`);
      }
    }
  }

  const { subscoreFloor } = config.normalization;
  if (subscoreFloor <= 0) {
    // Geometric aggregation multiplies subscores, so a floor of zero lets a
    // single missing pillar zero out an otherwise strong airport.
    throw new InvalidScoringConfigError('normalization.subscoreFloor must be greater than 0');
  }

  if (config.spill.kFactor <= 0 || config.spill.kFactor > 1) {
    throw new InvalidScoringConfigError('spill.kFactor must be between 0 and 1 (industry range is 0.30-0.52)');
  }

  if (!config.scale) throw new InvalidScoringConfigError('missing "scale" section');
  if (config.scale.floorEnplanements >= config.scale.ceilingEnplanements) {
    throw new InvalidScoringConfigError('scale.floorEnplanements must be below scale.ceilingEnplanements');
  }
  if (!config.scale.bands[config.scale.weighting]) {
    throw new InvalidScoringConfigError(`scale.weighting "${config.scale.weighting}" has no matching band`);
  }
  for (const [name, band] of Object.entries(config.scale.bands)) {
    if (band.min <= 0 || band.max < band.min) {
      throw new InvalidScoringConfigError(`scale.bands.${name} must satisfy 0 < min <= max`);
    }
  }

  if (!config.universe) throw new InvalidScoringConfigError('missing "universe" section');
  if (config.universe.minAnnualPassengers < 0) {
    throw new InvalidScoringConfigError('universe.minAnnualPassengers must not be negative');
  }
  if (config.universe.nationalCandidateLimit < 1) {
    throw new InvalidScoringConfigError('universe.nationalCandidateLimit must be at least 1');
  }

  if (!config.sensitivity) throw new InvalidScoringConfigError('missing "sensitivity" section');
  if (config.sensitivity.draws < 1) {
    throw new InvalidScoringConfigError('sensitivity.draws must be at least 1');
  }
  if (config.sensitivity.weightSpread <= 0) {
    // A zero spread would make every draw identical and report false certainty.
    throw new InvalidScoringConfigError('sensitivity.weightSpread must be greater than 0');
  }
  for (const field of ['robustThreshold', 'tieSwapThreshold'] as const) {
    const value = config.sensitivity[field];
    if (value < 0 || value > 1) {
      throw new InvalidScoringConfigError(`sensitivity.${field} must be between 0 and 1`);
    }
  }
}

function AssertSumsToOne(total: number, label: string) {
  if (Math.abs(total - 1) > SumTolerance) {
    throw new InvalidScoringConfigError(`${label} must sum to 1, got ${total}`);
  }
}

/**
 * Hashes the semantically meaningful parts of the config.
 *
 * Keys are sorted so that reformatting the JSON or reordering its keys does
 * not change the hash and needlessly invalidate every cached score.
 */
function HashConfig(config: ScoringConfig) {
  const canonical = JSON.stringify(config, Object.keys(config).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
