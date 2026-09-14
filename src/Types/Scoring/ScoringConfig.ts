/**
 * How Need and Payoff are combined into a single score.
 *
 *   geometric  (default)  Need^a * Payoff^b
 *   arithmetic            a*Need + b*Payoff
 *
 * Geometric refuses to let a strong pillar mask a dead one. Worked example:
 *
 *            Need  Payoff   arithmetic   geometric
 *   A          90      20      65.5 (1st)   53.2
 *   B          55      55      55.0         55.0 (1st)
 *
 * A is badly congested but unmonetizable; B is balanced. Arithmetic lets A's
 * congestion compensate for a near-dead payoff. Geometric requires both.
 *
 * Exposed as a user-switchable setting because the choice is a judgement
 * call, not a fact — and a reviewer should be able to see the ranking move.
 */
export type AggregationMode = 'geometric' | 'arithmetic';

/**
 * Which kind of capital project is being evaluated. Same engine, different
 * metric weights: terminal projects care about throughput, international share
 * and upgauging; airfield projects care about taxi times and saturation.
 */
export type ScoreProfileId = 'terminal' | 'airfield' | 'balanced';

/**
 * How much absolute passenger volume should count.
 *
 * Metrics are normalized WITHIN an airport's FAA hub-class cohort, which is
 * what makes a Small hub comparable to a Large one. The side effect is that a
 * cohort-relative score measures *intensity* — "how strong is this airport's
 * case relative to airports like it" — not the size of the opportunity. Left
 * unadjusted, a best-in-class nonhub outranks a merely-very-good mega-hub:
 * Bangor scored above Boston Logan as a terminal expansion candidate.
 *
 * For an investor, deal size is real. A 10% capacity gain at Logan supports
 * vastly more deployable capital than the same gain at Bangor.
 *
 *   none      pure intensity; ignore volume entirely
 *   moderate  log-scaled tilt toward larger airports (default)
 *   strong    pronounced tilt, for absolute-return mandates
 *
 * Scaling is logarithmic on purpose. Weighting linearly by passengers would
 * collapse the ranking into a size league table and discard every signal the
 * pillars work to produce.
 */
export type ScaleWeighting = 'none' | 'moderate' | 'strong';

export interface ScaleBand {
  min: number;
  max: number;
}

export interface ScaleBandsByWeighting {
  [weighting: string]: ScaleBand;
}

export interface ScaleConfig {
  weighting: ScaleWeighting;
  /** Enplanements mapping to the bottom of the band. FAA primary-airport threshold. */
  floorEnplanements: number;
  /** Enplanements mapping to the top of the band. */
  ceilingEnplanements: number;
  bands: ScaleBandsByWeighting;
}

export interface MetricWeights {
  [metricId: string]: number;
}

/** How Need is assembled from its two pillars. Must sum to 1. */
export interface NeedComposition {
  constraint: number;
  latentDemand: number;
}

export interface ScoreProfileConfig {
  id: ScoreProfileId;
  label: string;
  description: string;
  /** Overrides the global needComposition for this profile. */
  needComposition: NeedComposition;
  /** Per-metric weights within pillars. Overrides the registry default when present. */
  metricWeights: MetricWeights;
}

export interface ScoreProfilesById {
  [profileId: string]: ScoreProfileConfig;
}

export interface ScoringConfig {
  /** Bumped by hand when the methodology changes. Part of the cache key. */
  version: string;
  aggregation: AggregationMode;
  defaultProfile: ScoreProfileId;
  profiles: ScoreProfilesById;

  /** Default split of Need between its two pillars. Profiles may override. */
  needComposition: NeedComposition;

  /** Exponents for the geometric blend of Need and Payoff. Must sum to 1. */
  geometricExponents: {
    need: number;
    payoff: number;
  };

  normalization: {
    /** Percentile bounds for winsorizing, e.g. 0.05 / 0.95. */
    winsorLowerPercentile: number;
    winsorUpperPercentile: number;
    /** Steepness of the logistic squash applied to the robust z-score. */
    logisticSteepness: number;
    /**
     * Floor applied to every subscore. Geometric aggregation is brutal near
     * zero: without this, one weak pillar annihilates an otherwise strong
     * airport. Clamping at ~1 keeps the blend well-behaved.
     */
    subscoreFloor: number;
  };

  coverage: {
    /** Below this, a pillar is flagged low confidence. */
    lowConfidenceThreshold: number;
    /** Below this, an airport is excluded from rankings (but still queryable). */
    minimumForRanking: number;
  };

  spill: {
    /** Demand variability. Industry range 0.30-0.52; 0.35 is a common default. */
    kFactor: number;
  };

  scale: ScaleConfig;

  sensitivity: SensitivityConfig;

  universe: UniverseConfig;
}

/**
 * Which airports count as candidates at all.
 *
 * The snapshot holds every airport BTS reports, including general-aviation
 * fields that logged a handful of charter passengers in a year. Ranking
 * Atlanta's metro returned Gwinnett County (12 passengers) and Lee Gilmer
 * (7) alongside Hartsfield-Jackson, which is noise rather than analysis.
 */
export interface UniverseConfig {
  /**
   * Annual passenger floor for an airport to be treated as a candidate.
   * Defaults to the FAA commercial-service threshold of 2,500 enplanements.
   */
  minAnnualPassengers: number;
  /** Cap on a national ranking before scoring, to keep responses readable. */
  nationalCandidateLimit: number;
}

export interface SensitivityConfig {
  /** Number of resampled weightings per analysis. */
  draws: number;
  /** Log-normal sigma applied to each metric weight. 0.35 is roughly +/-40%. */
  weightSpread: number;
  /** Leading group size used for the stability test. */
  topN: number;
  /** Top-N retention rate above which a ranking is called robust. */
  robustThreshold: number;
  /** Swap rate above which two adjacent airports are reported as tied. */
  tieSwapThreshold: number;
  /** Fixed so the same question always returns the same robustness figure. */
  seed: number;
}

/** Caller-supplied overrides, e.g. "weight international traffic twice as much". */
export interface ScoringOverrides {
  aggregation?: AggregationMode;
  profile?: ScoreProfileId;
  scaleWeighting?: ScaleWeighting;
  metricWeights?: MetricWeights;
  /**
   * Pillar-level structure. Sensitivity analysis perturbs these as well as
   * the metric weights, because they are the larger judgement call: a
   * different analyst is far more likely to disagree about how Constraint
   * trades off against Latent Demand than about one metric's weight inside a
   * pillar. Perturbing only the latter would report false confidence.
   */
  needComposition?: NeedComposition;
  geometricExponents?: GeometricExponents;
}

export interface GeometricExponents {
  need: number;
  payoff: number;
}
