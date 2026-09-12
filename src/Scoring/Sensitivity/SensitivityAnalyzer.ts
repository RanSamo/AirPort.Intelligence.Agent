import { AllMetricIds } from '../../Metrics/MetricRegistry';
import { SeededRandom } from '../../Infrastructure/Math/SeededRandom';
import type { Airport } from '../../Types/Domain/Airport';
import type { MetricWeights, ScoringConfig, ScoringOverrides } from '../../Types/Scoring/ScoringConfig';
import type { PreparedUniverse, ScoringEngine } from '../ScoringEngine';
import type { RankDistribution, RankSwap, SensitivityResult } from '../../Types/Scoring/Sensitivity';

/**
 * How much a ranking depends on the weights we chose.
 *
 * The weights in ScoringConfig.json are judgement calls. A ranking built on
 * them is only as trustworthy as its stability under other reasonable
 * weightings, so the weights are resampled and the ranking recomputed many
 * times.
 *
 * This is what separates a real finding from an artefact. On the first live
 * run of the New England question, three airports landed within 0.1 points of
 * each other and were printed as ranks 2, 3 and 4 — an ordering the data does
 * not actually support. Without this analysis there is no way to tell that
 * apart from a genuine result.
 *
 * PERFORMANCE. Normalization depends only on the cohort, never on the
 * weights, so the universe is prepared once and only the weighted sum is
 * repeated. That is the difference between a sweep that takes half a minute
 * and one that runs inside a chat response.
 */

export interface SensitivityRequest {
  airports: Airport[];
  periodId: string;
  overrides: ScoringOverrides;
  draws?: number;
  topN?: number;
  /** Fixed by default so the same question always yields the same answer. */
  seed?: number;
}

interface RankSamples {
  [iata: string]: number[];
}

export class SensitivityAnalyzer {
  private readonly engine: ScoringEngine;
  private readonly config: ScoringConfig;

  constructor(engine: ScoringEngine, config: ScoringConfig) {
    this.engine = engine;
    this.config = config;
  }

  public Analyze(request: SensitivityRequest) {
    const settings = this.config.sensitivity;
    const draws = request.draws ?? settings.draws;
    const topN = request.topN ?? settings.topN;
    const seed = request.seed ?? settings.seed;

    const universe = this.engine.PrepareUniverse(request.periodId);
    const candidateCodes = request.airports.map((airport) => airport.iata);
    const baselineRanks = this.RankCodes(universe, candidateCodes, request.overrides);

    const random = new SeededRandom(seed);
    const samples: RankSamples = {};
    for (const iata of baselineRanks) samples[iata] = [];

    for (let draw = 0; draw < draws; draw += 1) {
      const perturbed = this.PerturbWeights(random, settings.weightSpread, request.overrides);
      const ranked = this.RankCodes(universe, candidateCodes, perturbed);

      ranked.forEach((iata, index) => {
        const bucket = samples[iata];
        if (bucket) bucket.push(index + 1);
      });
    }

    const distributions = this.BuildDistributions(baselineRanks, samples, request.airports, topN);
    const ties = this.FindTies(baselineRanks, samples, settings.tieSwapThreshold);
    const isRankingRobust = this.IsRobust(distributions, topN, settings.robustThreshold);

    const result: SensitivityResult = {
      draws,
      topN,
      weightSpread: settings.weightSpread,
      seed,
      distributions,
      ties,
      isRankingRobust,
      narrative: this.Narrate(distributions, ties, draws, topN, isRankingRobust),
    };
    return result;
  }

  /**
   * Ranked airport codes under one weighting, best first.
   *
   * Scores only the candidate set rather than the whole universe. Cohort
   * percentiles are irrelevant here and their sorting pass dominated the cost
   * when this ran across every airport on every draw.
   */
  private RankCodes(universe: PreparedUniverse, codes: string[], overrides: ScoringOverrides) {
    const scores = this.engine.ScoreSubsetFromPrepared(universe, codes, overrides);

    return codes
      .reduce((accumulator: { iata: string; score: number }[], iata) => {
        const score = scores[iata];
        if (score && score.coverage >= this.config.coverage.minimumForRanking) {
          accumulator.push({ iata, score: score.score });
        }
        return accumulator;
      }, [])
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.iata);
  }

  /**
   * Resamples every weight in the model.
   *
   * Perturbs BOTH levels, and the second matters more:
   *
   *   metric weights   how much taxi-out counts inside Constraint
   *   pillar structure how Constraint trades off against Latent Demand, and
   *                    Need against Payoff
   *
   * Perturbing only metric weights reports false confidence. When every
   * metric inside a pillar moves together, the pillar score does not change
   * at all, so the ranking looks perfectly stable while the assumption most
   * likely to differ between analysts was never tested.
   *
   * Log-normal factors keep the perturbation symmetric in proportion —
   * halving a weight is as likely as doubling it — which is the right
   * behaviour for quantities that only matter relative to one another.
   */
  private PerturbWeights(random: SeededRandom, spread: number, overrides: ScoringOverrides) {
    const profileId = overrides.profile ?? this.config.defaultProfile;
    const profile = this.config.profiles[profileId];
    const base = profile?.metricWeights ?? {};

    const metricWeights = AllMetricIds.reduce((accumulator: MetricWeights, metricId) => {
      const weight = overrides.metricWeights?.[metricId] ?? base[metricId] ?? 1;
      accumulator[metricId] = weight * random.NextWeightFactor(spread);
      return accumulator;
    }, {});

    const baseComposition = overrides.needComposition ?? profile?.needComposition ?? this.config.needComposition;
    const needComposition = this.PerturbPair(
      random,
      spread,
      baseComposition.constraint,
      baseComposition.latentDemand,
    );

    const baseExponents = overrides.geometricExponents ?? this.config.geometricExponents;
    const exponents = this.PerturbPair(random, spread, baseExponents.need, baseExponents.payoff);

    return {
      ...overrides,
      metricWeights,
      needComposition: { constraint: needComposition.first, latentDemand: needComposition.second },
      geometricExponents: { need: exponents.first, payoff: exponents.second },
    };
  }

  /** Perturbs a two-way split and renormalizes it back to summing to 1. */
  private PerturbPair(random: SeededRandom, spread: number, first: number, second: number) {
    const perturbedFirst = first * random.NextWeightFactor(spread);
    const perturbedSecond = second * random.NextWeightFactor(spread);
    const total = perturbedFirst + perturbedSecond;

    if (total <= 0) return { first, second };
    return { first: perturbedFirst / total, second: perturbedSecond / total };
  }

  private BuildDistributions(
    baselineRanks: string[],
    samples: RankSamples,
    airports: Airport[],
    topN: number,
  ) {
    const namesByCode = airports.reduce((accumulator: { [iata: string]: string }, airport) => {
      accumulator[airport.iata] = airport.name;
      return accumulator;
    }, {});

    return baselineRanks.map((iata, index) => {
      const observed = [...(samples[iata] ?? [])].sort((left, right) => left - right);
      const baselineRank = index + 1;

      const distribution: RankDistribution = {
        iata,
        airportName: namesByCode[iata] ?? iata,
        baselineRank,
        medianRank: this.Percentile(observed, 0.5),
        rankInterquartileRange: {
          lower: this.Percentile(observed, 0.25),
          upper: this.Percentile(observed, 0.75),
        },
        bestRank: observed.length > 0 ? observed[0] : baselineRank,
        worstRank: observed.length > 0 ? observed[observed.length - 1] : baselineRank,
        probabilityInTopN: this.Share(observed, (rank) => rank <= topN),
        probabilityAtBaselineRank: this.Share(observed, (rank) => rank === baselineRank),
      };
      return distribution;
    });
  }

  /**
   * Adjacent pairs that trade places often enough that presenting them in a
   * fixed order would overstate the evidence.
   */
  private FindTies(baselineRanks: string[], samples: RankSamples, threshold: number) {
    const ties: RankSwap[] = [];

    for (let index = 0; index + 1 < baselineRanks.length; index += 1) {
      const ahead = baselineRanks[index];
      const behind = baselineRanks[index + 1];

      const aheadSamples = samples[ahead] ?? [];
      const behindSamples = samples[behind] ?? [];
      const comparable = Math.min(aheadSamples.length, behindSamples.length);
      if (comparable === 0) continue;

      let swaps = 0;
      for (let draw = 0; draw < comparable; draw += 1) {
        if (aheadSamples[draw] > behindSamples[draw]) swaps += 1;
      }

      const swapRate = swaps / comparable;
      if (swapRate < threshold) continue;

      ties.push({
        iata: ahead,
        otherIata: behind,
        swapRate,
        narrative:
          `${ahead} and ${behind} trade places in ${(swapRate * 100).toFixed(0)}% of plausible weightings, ` +
          `so they should be treated as tied rather than ranked against each other.`,
      });
    }

    return ties;
  }

  private IsRobust(distributions: RankDistribution[], topN: number, threshold: number) {
    const leaders = distributions.filter((entry) => entry.baselineRank <= topN);
    if (leaders.length === 0) return false;
    return leaders.every((entry) => entry.probabilityInTopN >= threshold);
  }

  private Narrate(
    distributions: RankDistribution[],
    ties: RankSwap[],
    draws: number,
    topN: number,
    isRobust: boolean,
  ) {
    if (distributions.length === 0) return 'No airports had enough data to test.';

    const leader = distributions[0];
    const parts: string[] = [
      `Across ${draws} plausible weightings, ${leader.iata} ranked first in ` +
        `${(leader.probabilityAtBaselineRank * 100).toFixed(0)}% of them and stayed in the top ${topN} in ` +
        `${(leader.probabilityInTopN * 100).toFixed(0)}%.`,
    ];

    parts.push(
      isRobust
        ? `The leading group is stable, so the ordering reflects the data rather than the chosen weights.`
        : `The leading group shifts noticeably between weightings, so treat the exact order as indicative rather than settled.`,
    );

    for (const tie of ties) parts.push(tie.narrative);
    return parts.join(' ');
  }

  private Percentile(sortedValues: number[], percentile: number) {
    if (sortedValues.length === 0) return 0;
    const position = Math.min(
      sortedValues.length - 1,
      Math.max(0, Math.round((sortedValues.length - 1) * percentile)),
    );
    return sortedValues[position];
  }

  private Share(values: number[], predicate: (value: number) => boolean) {
    if (values.length === 0) return 0;
    return values.filter(predicate).length / values.length;
  }
}
