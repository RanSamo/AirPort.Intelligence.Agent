import type { IAggregator } from '../../Types/Ports/Scoring';

/**
 * Combines Need and Payoff as a weighted arithmetic mean:
 *
 *   score = needExponent * Need + payoffExponent * Payoff
 *
 * Offered as a user-switchable alternative to the geometric default. It is
 * easier to explain and more forgiving, but it allows compensation between
 * pillars: an airport that is severely constrained with little to monetise
 * can still rank highly.
 *
 * Exposing both is deliberate. The choice between them is a judgement about
 * the investment thesis rather than a fact about the data, so it belongs in
 * the user's hands and in the design document, not buried in the maths.
 */
export class ArithmeticAggregator implements IAggregator {
  public readonly mode = 'arithmetic';

  public Combine(need: number, payoff: number, needExponent: number, payoffExponent: number) {
    return need * needExponent + payoff * payoffExponent;
  }
}
