import type { AggregationMode } from '../../Types/Scoring/ScoringConfig';
import type { IAggregator } from '../../Types/Ports/Scoring';

export class UnknownAggregationModeError extends Error {
  constructor(mode: string) {
    super(`Unknown aggregation mode: "${mode}". Expected "geometric" or "arithmetic".`);
    this.name = 'UnknownAggregationModeError';
  }
}

interface AggregatorsByMode {
  [mode: string]: IAggregator;
}

/**
 * Resolves the aggregation strategy for a request.
 *
 * Both strategies are injected, so the geometric/arithmetic choice stays a
 * configuration value resolved at the edge rather than an `if` buried inside
 * the scoring maths. That is what lets a user flip the mode mid-conversation
 * and watch the ranking move, without any code path diverging.
 */
export class AggregatorFactory {
  private readonly aggregators: AggregatorsByMode;

  constructor(geometric: IAggregator, arithmetic: IAggregator) {
    this.aggregators = {
      geometric,
      arithmetic,
    };
  }

  public Resolve(mode: AggregationMode) {
    const aggregator = this.aggregators[mode];
    if (!aggregator) throw new UnknownAggregationModeError(mode);
    return aggregator;
  }
}
