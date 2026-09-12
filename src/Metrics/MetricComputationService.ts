import { ShiftMonthKey } from '../Infrastructure/Time/MonthSequence';
import type { CongestionMonthRecord, HaulMixRecord, TrafficMonthRecord } from '../Types/Ports/Repositories';
import type { ICongestionRepository, ITrafficRepository } from '../Types/Ports/Repositories';
import type { ILogger } from '../Types/Ports/Logger';
import type { MetricId } from '../Types/Domain/Metric';
import type { SpillModel } from '../Scoring/Spill/SpillModel';

/**
 * Turns snapshot facts into the 14 scored metrics.
 *
 * Everything here is deterministic arithmetic over stored rows — no model
 * judgement, no estimation of absent values. An airport that lacks the
 * underlying rows simply produces no value for that metric, and the coverage
 * machinery reports the gap rather than filling it.
 *
 * UNIT CONSISTENCY: On-Time Performance is domestic-only while T-100 covers
 * all traffic, so metrics combining the two use the domestic halves of both.
 * Mixing them misstates passengers-per-flight by +28% at JFK and -15% at ANC
 * (see CLAUDE.md 6.1a).
 */

export interface AnalysisWindows {
  periodId: string;
  /** Most recent 12 months of traffic data. */
  recentFrom: string;
  recentTo: string;
  /** The 12 months immediately before recent, for year-over-year trends. */
  priorFrom: string;
  priorTo: string;
  /** The 12 months three years before recent, for 3-year CAGR. */
  baseFrom: string;
  baseTo: string;
  /** Congestion window, bounded by what On-Time Performance covers. */
  congestionFrom: string;
  congestionTo: string;
}

export interface ComputedMetric {
  iata: string;
  metricId: MetricId;
  value: number;
  sampleSize: number;
}

interface TrafficByAirport {
  [iata: string]: TrafficMonthRecord[];
}

interface CongestionByAirport {
  [iata: string]: CongestionMonthRecord[];
}

interface HaulByAirport {
  [iata: string]: HaulMixRecord[];
}

interface TrafficByAirportMonth {
  [key: string]: TrafficMonthRecord;
}

/** A metric needs at least this many months before it is trustworthy. */
const MinimumMonths = 6;
/** Load factor threshold for the persistence metric. */
const HighLoadFactorThreshold = 0.85;

export class MetricComputationService {
  private readonly traffic: ITrafficRepository;
  private readonly congestion: ICongestionRepository;
  private readonly spillModel: SpillModel;
  private readonly logger: ILogger;

  constructor(
    traffic: ITrafficRepository,
    congestion: ICongestionRepository,
    spillModel: SpillModel,
    logger: ILogger,
  ) {
    this.traffic = traffic;
    this.congestion = congestion;
    this.spillModel = spillModel;
    this.logger = logger;
  }

  /**
   * Derives the analysis windows from what the snapshot actually contains,
   * rather than hard-coding dates that silently go stale after a re-ingest.
   */
  public ResolveWindows(periodId = 'latest_12m') {
    const trafficRange = this.traffic.GetAvailableRange();
    const congestionRange = this.congestion.GetAvailableRange();

    const recentTo = trafficRange.to;
    const recentFrom = ShiftMonthKey(recentTo, -11);

    const windows: AnalysisWindows = {
      periodId,
      recentFrom,
      recentTo,
      priorFrom: ShiftMonthKey(recentFrom, -12),
      priorTo: ShiftMonthKey(recentTo, -12),
      baseFrom: ShiftMonthKey(recentFrom, -36),
      baseTo: ShiftMonthKey(recentTo, -36),
      congestionFrom: congestionRange.from,
      congestionTo: congestionRange.to,
    };
    return windows;
  }

  public ComputeAll(windows: AnalysisWindows) {
    const recent = this.GroupTraffic(this.traffic.GetAllInRange(windows.recentFrom, windows.recentTo));
    const prior = this.GroupTraffic(this.traffic.GetAllInRange(windows.priorFrom, windows.priorTo));
    const base = this.GroupTraffic(this.traffic.GetAllInRange(windows.baseFrom, windows.baseTo));

    const congestionRows = this.congestion.GetAllInRange(windows.congestionFrom, windows.congestionTo);
    const congestion = this.GroupCongestion(congestionRows);
    const haul = this.GroupHaul(this.congestion.GetAllHaulMixInRange(windows.congestionFrom, windows.congestionTo));

    // Peak-hour passengers needs both sources for the same month, so it is
    // restricted to where the two windows overlap.
    const trafficByMonth = this.IndexTrafficByMonth(
      this.traffic.GetAllInRange(windows.congestionFrom, windows.congestionTo),
    );

    const computed: ComputedMetric[] = [];

    for (const [iata, months] of Object.entries(recent)) {
      this.AddTrafficMetrics(computed, iata, months, prior[iata] ?? [], base[iata] ?? []);
    }

    for (const [iata, months] of Object.entries(congestion)) {
      this.AddCongestionMetrics(computed, iata, months);
      this.AddPeakHourPassengers(computed, iata, months, trafficByMonth);
    }

    for (const [iata, months] of Object.entries(haul)) {
      this.AddHaulMetrics(computed, iata, months);
    }

    this.logger.Info('Metrics computed', {
      values: computed.length,
      airportsWithTraffic: Object.keys(recent).length,
      airportsWithCongestion: Object.keys(congestion).length,
    });

    return computed;
  }

  // --- Traffic-derived metrics (T-100) ------------------------------------

  private AddTrafficMetrics(
    target: ComputedMetric[],
    iata: string,
    recent: TrafficMonthRecord[],
    prior: TrafficMonthRecord[],
    base: TrafficMonthRecord[],
  ) {
    if (recent.length < MinimumMonths) return;

    const recentTotals = this.SumTraffic(recent);

    if (recentTotals.seats > 0) {
      this.Push(target, iata, 'avg_load_factor', recentTotals.passengers / recentTotals.seats, recent.length);
    }

    const highMonths = recent.filter((month) => month.loadFactor > HighLoadFactorThreshold).length;
    this.Push(target, iata, 'pct_months_lf_gt_85', highMonths / recent.length, recent.length);

    if (recentTotals.passengers > 0) {
      this.Push(
        target,
        iata,
        'intl_pax_share',
        recentTotals.internationalPassengers / recentTotals.passengers,
        recent.length,
      );

      // Passenger-weighted, since the stored value is already a per-month average.
      const weightedMiles = recent.reduce(
        (sum, month) => sum + month.passengerMilesAvg * month.passengers,
        0,
      );
      this.Push(target, iata, 'avg_passenger_trip_miles', weightedMiles / recentTotals.passengers, recent.length);
    }

    const spill = this.spillModel.AggregateSpillRate(recent);
    if (spill) this.Push(target, iata, 'spill_rate', spill.spillRate, spill.months);

    // Upgauging: domestic basis, because blending international widebodies
    // distorts seats-per-departure by up to 24%.
    const priorTotals = this.SumTraffic(prior);
    if (prior.length >= MinimumMonths && priorTotals.domesticDepartures > 0 && recentTotals.domesticDepartures > 0) {
      const recentGauge = recentTotals.domesticSeats / recentTotals.domesticDepartures;
      const priorGauge = priorTotals.domesticSeats / priorTotals.domesticDepartures;
      if (priorGauge > 0) {
        this.Push(target, iata, 'seats_per_departure_trend', recentGauge / priorGauge - 1, recent.length);
      }
    }

    const baseTotals = this.SumTraffic(base);
    if (base.length >= MinimumMonths) {
      const passengerCagr = this.Cagr(baseTotals.passengers, recentTotals.passengers, 3);
      if (passengerCagr !== null) this.Push(target, iata, 'enplanement_cagr_3y', passengerCagr, recent.length);

      const seatCagr = this.Cagr(baseTotals.seats, recentTotals.seats, 3);
      if (seatCagr !== null) this.Push(target, iata, 'seat_cagr_3y', seatCagr, recent.length);
    }
  }

  // --- Congestion metrics (On-Time Performance) ---------------------------

  private AddCongestionMetrics(target: ComputedMetric[], iata: string, months: CongestionMonthRecord[]) {
    if (months.length < MinimumMonths) return;

    const totals = months.reduce(
      (accumulator: CongestionTotals, month) => {
        accumulator.flights += month.flights;
        accumulator.delayed15 += month.departuresDelayed15;
        accumulator.nas += month.nasDelayMinutes;
        accumulator.allDelay +=
          month.nasDelayMinutes +
          month.weatherDelayMinutes +
          month.carrierDelayMinutes +
          month.lateAircraftDelayMinutes +
          month.securityDelayMinutes;
        // Flight-weighted so a quiet month does not count as much as a busy one.
        accumulator.taxiP50Weighted += month.taxiOutP50 * month.flights;
        accumulator.taxiP90Weighted += month.taxiOutP90 * month.flights;
        return accumulator;
      },
      { flights: 0, delayed15: 0, nas: 0, allDelay: 0, taxiP50Weighted: 0, taxiP90Weighted: 0 },
    );

    if (totals.flights <= 0) return;

    this.Push(target, iata, 'taxi_out_p50', totals.taxiP50Weighted / totals.flights, months.length);
    this.Push(target, iata, 'taxi_out_p90', totals.taxiP90Weighted / totals.flights, months.length);
    this.Push(target, iata, 'dep_delay_15_rate', totals.delayed15 / totals.flights, months.length);

    if (totals.allDelay > 0) {
      this.Push(target, iata, 'nas_delay_share', totals.nas / totals.allDelay, months.length);
    }
  }

  /**
   * Peak-hour passenger throughput — the measure terminals are sized against.
   *
   * peak-hour domestic departures x domestic passengers per departure, taken
   * at the busiest month. Taking the peak month rather than the mean captures
   * seasonal peaking without needing a separate seasonality metric: the
   * busiest month is by definition the one that produces the highest value.
   */
  private AddPeakHourPassengers(
    target: ComputedMetric[],
    iata: string,
    months: CongestionMonthRecord[],
    trafficByMonth: TrafficByAirportMonth,
  ) {
    const monthly = months.reduce((accumulator: number[], month) => {
      const traffic = trafficByMonth[`${iata}|${month.monthKey}`];
      if (!traffic || traffic.domesticDepartures <= 0 || month.peakHourDepartures <= 0) return accumulator;

      const passengersPerDeparture = traffic.domesticPassengers / traffic.domesticDepartures;
      accumulator.push(month.peakHourDepartures * passengersPerDeparture);
      return accumulator;
    }, []);

    if (monthly.length === 0) return;
    this.Push(target, iata, 'peak_hour_passengers', Math.max(...monthly), monthly.length);
  }

  private AddHaulMetrics(target: ComputedMetric[], iata: string, months: HaulMixRecord[]) {
    const totals = months.reduce(
      (accumulator: HaulTotals, month) => {
        accumulator.long += month.longHaulFlights;
        accumulator.total += month.totalFlights;
        return accumulator;
      },
      { long: 0, total: 0 },
    );

    if (totals.total <= 0) return;
    this.Push(target, iata, 'long_haul_share', totals.long / totals.total, months.length);
  }

  // --- Helpers -------------------------------------------------------------

  /** Compound annual growth rate. Null when the base is non-positive. */
  private Cagr(startValue: number, endValue: number, years: number) {
    if (startValue <= 0 || endValue <= 0) return null;
    return Math.pow(endValue / startValue, 1 / years) - 1;
  }

  private SumTraffic(months: TrafficMonthRecord[]) {
    return months.reduce(
      (accumulator: TrafficTotals, month) => {
        accumulator.passengers += month.passengers;
        accumulator.seats += month.seats;
        accumulator.departures += month.departures;
        accumulator.domesticDepartures += month.domesticDepartures;
        accumulator.domesticSeats += month.domesticSeats;
        accumulator.internationalPassengers += month.internationalPassengers;
        return accumulator;
      },
      {
        passengers: 0,
        seats: 0,
        departures: 0,
        domesticDepartures: 0,
        domesticSeats: 0,
        internationalPassengers: 0,
      },
    );
  }

  private Push(target: ComputedMetric[], iata: string, metricId: MetricId, value: number, sampleSize: number) {
    if (!Number.isFinite(value)) return;
    target.push({ iata, metricId, value, sampleSize });
  }

  private GroupTraffic(rows: TrafficMonthRecord[]) {
    return rows.reduce((accumulator: TrafficByAirport, row) => {
      const existing = accumulator[row.iata];
      if (existing) existing.push(row);
      else accumulator[row.iata] = [row];
      return accumulator;
    }, {});
  }

  private GroupCongestion(rows: CongestionMonthRecord[]) {
    return rows.reduce((accumulator: CongestionByAirport, row) => {
      const existing = accumulator[row.iata];
      if (existing) existing.push(row);
      else accumulator[row.iata] = [row];
      return accumulator;
    }, {});
  }

  private GroupHaul(rows: HaulMixRecord[]) {
    return rows.reduce((accumulator: HaulByAirport, row) => {
      const existing = accumulator[row.iata];
      if (existing) existing.push(row);
      else accumulator[row.iata] = [row];
      return accumulator;
    }, {});
  }

  private IndexTrafficByMonth(rows: TrafficMonthRecord[]) {
    return rows.reduce((accumulator: TrafficByAirportMonth, row) => {
      accumulator[`${row.iata}|${row.monthKey}`] = row;
      return accumulator;
    }, {});
  }
}

interface TrafficTotals {
  passengers: number;
  seats: number;
  departures: number;
  domesticDepartures: number;
  domesticSeats: number;
  internationalPassengers: number;
}

interface CongestionTotals {
  flights: number;
  delayed15: number;
  nas: number;
  allDelay: number;
  taxiP50Weighted: number;
  taxiP90Weighted: number;
}

interface HaulTotals {
  long: number;
  total: number;
}
