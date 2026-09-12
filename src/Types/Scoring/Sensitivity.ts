import type { IataCode } from '../Domain/Airport';

/**
 * Weight sensitivity analysis.
 *
 * The pillar and metric weights are judgement calls, not facts. A ranking
 * built on them is only trustworthy to the extent it survives reasonable
 * alternative weightings, so the weights are resampled and the ranking
 * recomputed many times.
 *
 * This is what separates "BOS is the strongest candidate" from "BGR edged out
 * PWM by 0.1 points because of a number in a config file". Without it the two
 * are indistinguishable in the output.
 */

export interface RankDistribution {
  iata: IataCode;
  airportName: string;
  /** Rank under the configured weights. */
  baselineRank: number;
  medianRank: number;
  /** 25th and 75th percentile rank across draws. */
  rankInterquartileRange: { lower: number; upper: number };
  bestRank: number;
  worstRank: number;
  /** Share of draws in which this airport landed in the top N, 0-1. */
  probabilityInTopN: number;
  /** Share of draws in which it held exactly its baseline rank, 0-1. */
  probabilityAtBaselineRank: number;
}

export interface RankDistributionsByCode {
  [iataCode: string]: RankDistribution;
}

/**
 * A pair of airports that trade places often enough that presenting them in a
 * fixed order would overstate what the data supports.
 */
export interface RankSwap {
  iata: IataCode;
  otherIata: IataCode;
  /** Share of draws in which their baseline order reversed, 0-1. */
  swapRate: number;
  narrative: string;
}

export interface SensitivityResult {
  draws: number;
  topN: number;
  /** Log-normal sigma applied to each metric weight. */
  weightSpread: number;
  seed: number;
  distributions: RankDistribution[];
  /** Pairs too close to separate; the agent must present these as tied. */
  ties: RankSwap[];
  /** True when the top-N membership held across most draws. */
  isRankingRobust: boolean;
  narrative: string;
}
