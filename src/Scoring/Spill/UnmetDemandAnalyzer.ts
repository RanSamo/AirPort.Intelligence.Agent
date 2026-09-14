import type { ICongestionRepository, ITrafficRepository, TrafficMonthRecord } from '../../Types/Ports/Repositories';
import type { SpillModel } from './SpillModel';
import type {
  SpillEstimatesByMonth,
  UnmetDemandAssessment,
  UnmetDemandDriverEvidence,
} from '../../Types/Scoring/Spill';

/**
 * Estimates unmet demand and attributes what is causing it.
 *
 * The spill quantity comes from SpillModel. This adds the "why": route-level
 * load factors do not exist in any free source, so attribution is inferred
 * from how seats, departures and passengers moved relative to one another,
 * plus whether system-cause congestion is suppressing schedule growth.
 *
 * Lives in the domain layer rather than inside the tool, so it can be unit
 * tested and so the tool stays a thin adapter over data it receives.
 */

/** Load factor above which seats are treated as the binding constraint. */
const SeatConstrainedThreshold = 0.82;
/** Growth gap implying frequency, not seats, is the limit. */
const FrequencyGapThreshold = 0.02;
/** System-cause delay share above which congestion is suppressing schedule. */
const CongestionSuppressedThreshold = 0.25;

export interface UnmetDemandRequest {
  iata: string;
  airportName: string;
  trafficFrom: string;
  trafficTo: string;
  congestionFrom: string;
  congestionTo: string;
}

export class UnmetDemandAnalyzer {
  private readonly spillModel: SpillModel;
  private readonly traffic: ITrafficRepository;
  private readonly congestion: ICongestionRepository;

  constructor(spillModel: SpillModel, traffic: ITrafficRepository, congestion: ICongestionRepository) {
    this.spillModel = spillModel;
    this.traffic = traffic;
    this.congestion = congestion;
  }

  /** Returns null when the airport has no usable traffic in the window. */
  public Assess(request: UnmetDemandRequest) {
    const months = this.traffic.GetMonths(request.iata, request.trafficFrom, request.trafficTo);
    if (months.length === 0) return null;

    const aggregate = this.spillModel.AggregateSpillRate(months);
    const monthly = months.reduce((accumulator: SpillEstimatesByMonth, month) => {
      const estimate = this.spillModel.EstimateMonth(month);
      if (estimate) accumulator[month.monthKey] = estimate;
      return accumulator;
    }, {});

    const peakMonth = Object.values(monthly).reduce(
      (best, estimate) => (best === null || estimate.spilledPassengers > best.spilledPassengers ? estimate : best),
      null as null | SpillEstimatesByMonth[string],
    );

    const assessment: UnmetDemandAssessment = {
      iata: request.iata,
      airportName: request.airportName,
      periodLabel: `${request.trafficFrom} to ${request.trafficTo}`,
      totalSpilledPassengers: aggregate ? aggregate.spilledPassengers : 0,
      averageSpillRate: aggregate ? aggregate.spillRate : 0,
      peakMonth: peakMonth ? peakMonth.monthKey : '',
      monthly,
      drivers: this.AttributeDrivers(request, months),
      caveats: [
        'Lower bound: segment traffic summarized per airport cannot see passengers recaptured on another flight, another day, or at a nearby airport.',
        'Spill cannot be attributed to specific routes, because route-level load factors are not published in any free source.',
      ],
    };
    return assessment;
  }

  private AttributeDrivers(request: UnmetDemandRequest, months: TrafficMonthRecord[]) {
    const drivers: UnmetDemandDriverEvidence[] = [];

    const totals = months.reduce(
      (accumulator: { passengers: number; seats: number; departures: number }, month) => {
        accumulator.passengers += month.passengers;
        accumulator.seats += month.seats;
        accumulator.departures += month.departures;
        return accumulator;
      },
      { passengers: 0, seats: 0, departures: 0 },
    );

    const loadFactor = totals.seats > 0 ? totals.passengers / totals.seats : 0;

    if (loadFactor >= SeatConstrainedThreshold) {
      drivers.push({
        driver: 'seat_constrained',
        weight: 0,
        narrative: `Aircraft run ${(loadFactor * 100).toFixed(1)}% full on average, leaving little room to carry more passengers on existing flights.`,
        supportingMetrics: ['avg_load_factor'],
      });
    }

    // Passengers growing faster than departures means carriers are filling
    // and upgauging aircraft rather than adding them, which points at a
    // frequency limit rather than a seat limit.
    const midpoint = Math.floor(months.length / 2);
    if (midpoint > 0) {
      const passengerGrowth = this.GrowthRate(months.slice(0, midpoint), months.slice(midpoint), (m) => m.passengers);
      const departureGrowth = this.GrowthRate(months.slice(0, midpoint), months.slice(midpoint), (m) => m.departures);

      if (passengerGrowth - departureGrowth > FrequencyGapThreshold) {
        drivers.push({
          driver: 'frequency_constrained',
          weight: 0,
          narrative: `Passengers grew ${(passengerGrowth * 100).toFixed(1)}% while departures grew ${(departureGrowth * 100).toFixed(1)}%, so carriers are absorbing demand by filling aircraft rather than adding flights.`,
          supportingMetrics: ['enplanement_cagr_3y', 'seats_per_departure_trend'],
        });
      }
    }

    const nasShare = this.SystemCauseShare(request);
    if (nasShare > CongestionSuppressedThreshold) {
      drivers.push({
        driver: 'congestion_suppressed',
        weight: 0,
        narrative: `${(nasShare * 100).toFixed(0)}% of delay minutes are system-cause (airspace and runway capacity) rather than weather, suggesting the infrastructure itself limits how much schedule the airport can absorb.`,
        supportingMetrics: ['nas_delay_share'],
      });
    }

    if (drivers.length === 0) {
      drivers.push({
        driver: 'seat_constrained',
        weight: 1,
        narrative:
          'No single constraint stands out. The estimated spill reflects ordinary day-to-day demand variation against fixed seat capacity.',
        supportingMetrics: ['avg_load_factor'],
      });
      return drivers;
    }

    // Even weighting: the evidence supports ranking causes as present, not
    // apportioning spill between them. Claiming a precise split would be a
    // fabricated number.
    const share = 1 / drivers.length;
    return drivers.map((driver) => ({ ...driver, weight: share }));
  }

  private SystemCauseShare(request: UnmetDemandRequest) {
    const congestion = this.congestion.GetMonths(request.iata, request.congestionFrom, request.congestionTo);
    if (congestion.length === 0) return 0;

    const totals = congestion.reduce(
      (accumulator: { nas: number; all: number }, month) => {
        accumulator.nas += month.nasDelayMinutes;
        accumulator.all +=
          month.nasDelayMinutes +
          month.weatherDelayMinutes +
          month.carrierDelayMinutes +
          month.lateAircraftDelayMinutes +
          month.securityDelayMinutes;
        return accumulator;
      },
      { nas: 0, all: 0 },
    );

    return totals.all > 0 ? totals.nas / totals.all : 0;
  }

  private GrowthRate(
    early: TrafficMonthRecord[],
    late: TrafficMonthRecord[],
    select: (month: TrafficMonthRecord) => number,
  ) {
    const earlySum = early.reduce((total, month) => total + select(month), 0);
    const lateSum = late.reduce((total, month) => total + select(month), 0);
    if (earlySum <= 0) return 0;
    return lateSum / earlySum - 1;
  }
}
