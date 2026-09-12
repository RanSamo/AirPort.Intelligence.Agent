import { LoadScoringConfig } from '../../src/Config/LoadScoringConfig';
import type { Airport, HubClass } from '../../src/Types/Domain/Airport';
import type { TrafficMonthRecord } from '../../src/Types/Ports/Repositories';

/**
 * Shared fixtures.
 *
 * The real ScoringConfig.json is loaded rather than a stub, so the suite also
 * acts as a standing check that the shipped configuration is valid and that
 * its weights still sum correctly.
 */
export const { config: TestConfig } = LoadScoringConfig();

export function BuildAirport(overrides: Partial<Airport> = {}) {
  const airport: Airport = {
    iata: 'TST',
    icao: 'KTST',
    name: 'Test Regional Airport',
    municipality: 'Testville',
    state: 'MA',
    latitude: 42,
    longitude: -71,
    hubClass: 'Medium' as HubClass,
    annualEnplanements: 1_000_000,
    enplanementShare: 0.001,
    reportsOnTimePerformance: true,
    ...overrides,
  };
  return airport;
}

export function BuildTrafficMonth(overrides: Partial<TrafficMonthRecord> = {}) {
  const seats = overrides.seats ?? 100_000;
  const passengers = overrides.passengers ?? 80_000;

  const record: TrafficMonthRecord = {
    iata: 'TST',
    monthKey: '2026-01',
    departures: 1_000,
    passengers,
    seats,
    loadFactor: seats > 0 ? passengers / seats : 0,
    domesticDepartures: 900,
    domesticPassengers: 72_000,
    domesticSeats: 90_000,
    internationalPassengers: 8_000,
    passengerMilesAvg: 900,
    ...overrides,
  };
  return record;
}

/** Evenly spread values, useful for asserting percentile behaviour. */
export function BuildLinearSeries(count: number, from = 1, to = 100) {
  const step = count > 1 ? (to - from) / (count - 1) : 0;
  return Array.from({ length: count }, (_unused, index) => from + index * step);
}
