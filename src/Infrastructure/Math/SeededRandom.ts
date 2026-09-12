/**
 * Deterministic pseudo-random number generator (mulberry32).
 *
 * Sensitivity analysis must be reproducible: a robustness figure that moved
 * every time you asked the same question would undermine the very thing it
 * exists to establish. Seeding also makes the behaviour testable.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  public Next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Standard normal, via the Box-Muller transform. */
  public NextGaussian() {
    // Guard against log(0), which the uniform generator can produce.
    const first = Math.max(this.Next(), Number.EPSILON);
    const second = this.Next();
    return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
  }

  /**
   * Multiplicative jitter centred on 1.
   *
   * Log-normal rather than uniform so the perturbation is symmetric in
   * proportion: halving a weight is exactly as likely as doubling it, which
   * is the right behaviour for quantities that are only meaningful relative
   * to each other.
   */
  public NextWeightFactor(spread: number) {
    return Math.exp(spread * this.NextGaussian());
  }
}
