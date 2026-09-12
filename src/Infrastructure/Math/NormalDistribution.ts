/**
 * Standard normal distribution helpers.
 *
 * Needed by the spill model, which inverts the expected-boardings equation to
 * recover latent demand. JavaScript has no erf, so it is approximated here.
 */

/** Standard normal probability density. */
export function StandardNormalPdf(z: number) {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal cumulative distribution.
 *
 * Abramowitz & Stegun 7.1.26 applied to erf; absolute error < 1.5e-7, which
 * is far tighter than the uncertainty in the k-factor the spill model uses.
 */
export function StandardNormalCdf(z: number) {
  return 0.5 * (1 + Erf(z / Math.SQRT2));
}

function Erf(x: number) {
  const sign = x < 0 ? -1 : 1;
  const absoluteX = Math.abs(x);

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * absoluteX);
  const polynomial = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  const result = 1 - polynomial * Math.exp(-absoluteX * absoluteX);

  return sign * result;
}

/**
 * Expected value of min(D, capacity) where D ~ Normal(mean, sigma).
 *
 * This is observed boardings: passengers actually carried when demand is
 * random but seats are finite. Derived from the normal loss function
 *   E[max(0, D - c)] = sigma * pdf(z) + (mean - c) * (1 - cdf(z))
 * with z = (c - mean) / sigma.
 */
export function ExpectedBoardings(mean: number, sigma: number, capacity: number) {
  if (sigma <= 0) return Math.min(mean, capacity);

  const z = (capacity - mean) / sigma;
  const expectedSpill = sigma * StandardNormalPdf(z) + (mean - capacity) * (1 - StandardNormalCdf(z));
  return mean - expectedSpill;
}
