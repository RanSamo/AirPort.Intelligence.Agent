import type { IAggregator } from '../../Types/Ports/Scoring';

/**
 * Combines Need and Payoff as a weighted geometric mean:
 *
 *   score = Need^needExponent * Payoff^payoffExponent
 *
 * This is the default because it refuses to let one strong pillar paper over
 * a dead one. With the configured 0.65 / 0.35 exponents:
 *
 *            Need  Payoff   arithmetic   geometric
 *   A          90      20      65.5 (1st)   53.2
 *   B          55      55      55.0         55.0 (1st)
 *
 * A is badly congested but has nothing worth monetising; B is balanced.
 * Arithmetic lets A's congestion compensate for a near-dead payoff and ranks
 * it first. Geometric requires both halves of the thesis to hold, which is
 * how the investment case actually works.
 *
 * The cost is behaviour near zero, where the product collapses hard. That is
 * handled upstream by the subscoreFloor in normalization, which keeps every
 * subscore at or above ~1 so a single weak pillar cannot annihilate an
 * otherwise strong airport.
 */
export class GeometricAggregator implements IAggregator {
  public readonly mode = 'geometric';

  public Combine(need: number, payoff: number, needExponent: number, payoffExponent: number) {
    const safeNeed = Math.max(need, Number.EPSILON);
    const safePayoff = Math.max(payoff, Number.EPSILON);
    return Math.pow(safeNeed, needExponent) * Math.pow(safePayoff, payoffExponent);
  }
}
