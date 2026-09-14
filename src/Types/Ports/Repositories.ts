import type { Airport, AirportsByCode, HubClass, IataCode, UsStateCode } from '../Domain/Airport';
import type { AirportFacilityRecord, FacilityRecordsByCode } from '../Domain/Facility';
import type { MetricId, MetricValuesByMetricAndAirport } from '../Domain/Metric';
import type { MonthKey, MonthlyValues } from '../Domain/Period';
import type { RegionDefinition, RegionsById } from '../Domain/Region';
import type { SnapshotMeta } from '../Data/Snapshot';

/**
 * Monthly traffic facts from T-100 (airport x month).
 *
 * Domestic fields are not redundant with the totals: BTS On-Time Performance
 * is domestic-only, so any metric pairing an OTP flight count with a T-100
 * average must use the domestic halves of both. See CLAUDE.md section 6.1a.
 */
export interface TrafficMonthRecord {
  iata: IataCode;
  monthKey: MonthKey;
  departures: number;
  passengers: number;
  seats: number;
  loadFactor: number;
  domesticDepartures: number;
  domesticPassengers: number;
  domesticSeats: number;
  internationalPassengers: number;
  /** Average distance flown per departing passenger, statute miles. */
  passengerMilesAvg: number;
}

/** Monthly congestion facts aggregated from OTP (airport x month). */
export interface CongestionMonthRecord {
  iata: IataCode;
  monthKey: MonthKey;
  flights: number;
  taxiOutP50: number;
  taxiOutP90: number;
  departuresDelayed15: number;
  cancelled: number;
  nasDelayMinutes: number;
  weatherDelayMinutes: number;
  carrierDelayMinutes: number;
  lateAircraftDelayMinutes: number;
  securityDelayMinutes: number;
  /** 95th percentile of scheduled departures in any single clock hour. */
  peakHourDepartures: number;
}

/** Flights bucketed by great-circle distance, for haul-mix questions. */
export interface HaulMixRecord {
  iata: IataCode;
  monthKey: MonthKey;
  shortHaulFlights: number;
  mediumHaulFlights: number;
  longHaulFlights: number;
  totalFlights: number;
}

export interface AirportFilter {
  states?: UsStateCode[];
  hubClasses?: HubClass[];
  regionId?: string;
  iataCodes?: IataCode[];
  requiresOnTimeReporting?: boolean;
  /**
   * Annual passenger floor. Excludes general-aviation fields that logged a
   * handful of charter passengers. Defaults to the configured
   * commercial-service threshold when omitted.
   */
  minAnnualPassengers?: number;
  /** Caps how many candidates are returned, largest first. */
  limit?: number;
}

export interface IAirportRepository {
  GetByCode(iata: IataCode): Airport | null;
  GetManyByCode(codes: IataCode[]): AirportsByCode;
  GetAll(): AirportsByCode;
  Find(filter: AirportFilter): Airport[];
  FindWithinRadius(latitude: number, longitude: number, radiusKm: number): Airport[];
  SearchByText(query: string, limit: number): Airport[];
  GetRegions(): RegionsById;
  GetRegion(regionId: string): RegionDefinition | null;
}

export interface IFacilityRepository {
  GetByCode(iata: IataCode): AirportFacilityRecord | null;
  GetAll(): FacilityRecordsByCode;
  CountCuratedGates(): number;
}

export interface ITrafficRepository {
  GetMonths(iata: IataCode, from: MonthKey, to: MonthKey): TrafficMonthRecord[];
  /** Bulk read for metric computation: one query instead of one per airport. */
  GetAllInRange(from: MonthKey, to: MonthKey): TrafficMonthRecord[];
  GetAvailableRange(): { from: MonthKey; to: MonthKey };
}

export interface ICongestionRepository {
  GetMonths(iata: IataCode, from: MonthKey, to: MonthKey): CongestionMonthRecord[];
  GetAllInRange(from: MonthKey, to: MonthKey): CongestionMonthRecord[];
  GetHaulMix(iata: IataCode, from: MonthKey, to: MonthKey): HaulMixRecord[];
  GetAllHaulMixInRange(from: MonthKey, to: MonthKey): HaulMixRecord[];
  HasData(iata: IataCode): boolean;
  GetAvailableRange(): { from: MonthKey; to: MonthKey };
}

export interface MetricValueRow {
  iata: IataCode;
  metricId: MetricId;
  value: number;
  sampleSize: number;
}

export interface IMetricRepository {
  GetForAirports(codes: IataCode[], metricIds: MetricId[], periodId: string): MetricValuesByMetricAndAirport;
  GetAllForPeriod(periodId: string): MetricValuesByMetricAndAirport;
  /** Replaces the stored values for a period. */
  Replace(rows: MetricValueRow[], periodId: string): void;
}

export interface ISnapshotRepository {
  GetMeta(): SnapshotMeta | null;
  SaveMeta(meta: SnapshotMeta): void;
}
