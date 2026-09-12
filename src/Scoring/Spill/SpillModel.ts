import { ExpectedBoardings } from '../../Infrastructure/Math/NormalDistribution';
import type { SpillEstimate } from '../../Types/Scoring/Spill';
import type { TrafficMonthRecord } from '../../Types/Ports/Repositories';

/**
 * Airline spill model — estimating demand that was turned away.
 *
 * Standard Belobaba / Boeing spill analysis. For an airport-month with S
 * seats carrying P passengers:
 *
 *   1. assume latent demand D ~ Normal(mu, sigma) with sigma = k * mu
 *   2. observed boardings P = E[min(D, S)]
 *   3. invert numerically for mu
 *   4. spill = mu - P ;  spillRate = spill / mu
 *
 * The intuition: an airport running at 95% load factor is not "5% empty", it
 * is turning people away on the full days. Demand varies day to day, so the
 * fuller the average, the more demand sits above the seat line unserved.
 *
 * SCOPING — stated in every answer that uses this:
 * T-100 reports segment (nonstop) traffic summarized per airport, and
 * route-level load factors are not available from any free source. So this is
 * a LOWER BOUND. It cannot see passengers recaptured on another flight, a
 * different day, or a neighbouring airport, and it cannot attribute spill to
 * specific routes.
 */

/** Inversion bounds. Demand is never below observed boardings. */
const MaxDemandMultiple = 4;
const BisectionIterations = 60;
const ConvergenceTolerance = 1e-6;

export class SpillModel {
  private readonly kFactor: number;

  constructor(kFactor: number) {
    this.kFactor = kFactor;
  }

  /**
   * Recovers latent demand for one airport-month.
   * Returns null when the month carries no usable capacity data.
   */
  public EstimateMonth(record: TrafficMonthRecord) {
    const { seats, passengers } = record;
    if (seats <= 0 || passengers <= 0) return null;

    const demand = this.SolveForDemand(passengers, seats);
    const spilled = Math.max(0, demand - passengers);

    const estimate: SpillEstimate = {
      iata: record.iata,
      monthKey: record.monthKey,
      seats,
      passengers,
      observedLoadFactor: passengers / seats,
      estimatedDemand: demand,
      spilledPassengers: spilled,
      spillRate: demand > 0 ? spilled / demand : 0,
      kFactor: this.kFactor,
    };
    return estimate;
  }

  /**
   * Aggregate spill rate across months: total spilled over total demand.
   *
   * Weighted by volume rather than averaging monthly rates, so a tiny
   * shoulder month does not carry the same weight as a peak one.
   */
  public AggregateSpillRate(records: TrafficMonthRecord[]) {
    const totals = records.reduce(
      (accumulator: SpillTotals, record) => {
        const estimate = this.EstimateMonth(record);
        if (!estimate) return accumulator;
        accumulator.demand += estimate.estimatedDemand;
        accumulator.spilled += estimate.spilledPassengers;
        accumulator.months += 1;
        return accumulator;
      },
      { demand: 0, spilled: 0, months: 0 },
    );

    if (totals.months === 0 || totals.demand <= 0) return null;
    return { spillRate: totals.spilled / totals.demand, spilledPassengers: totals.spilled, months: totals.months };
  }

  /**
   * Inverts E[min(D, seats)] = passengers for mu by bisection.
   *
   * The function is monotonic in mu, so bisection is both safe and
   * sufficient — no derivative, no risk of Newton overshooting into
   * negative demand.
   */
  private SolveForDemand(passengers: number, seats: number) {
    let lower = passengers;
    let upper = passengers * MaxDemandMultiple;

    for (let iteration = 0; iteration < BisectionIterations; iteration += 1) {
      const midpoint = (lower + upper) / 2;
      const predicted = ExpectedBoardings(midpoint, this.kFactor * midpoint, seats);

      if (Math.abs(predicted - passengers) < ConvergenceTolerance) return midpoint;
      if (predicted < passengers) lower = midpoint;
      else upper = midpoint;
    }

    return (lower + upper) / 2;
  }
}

interface SpillTotals {
  demand: number;
  spilled: number;
  months: number;
}
