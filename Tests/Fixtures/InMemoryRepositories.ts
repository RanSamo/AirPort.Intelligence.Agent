import type { Airport, AirportsByCode } from '../../src/Types/Domain/Airport';
import type { AirportFacilityRecord, FacilityRecordsByCode } from '../../src/Types/Domain/Facility';
import type { AirportFilter, IAirportRepository, IFacilityRepository, IMetricRepository, MetricValueRow } from '../../src/Types/Ports/Repositories';
import type { MetricId, MetricValuesByMetricAndAirport } from '../../src/Types/Domain/Metric';
import type { RegionDefinition, RegionsById } from '../../src/Types/Domain/Region';

/**
 * In-memory repositories for tests.
 *
 * These exist to demonstrate the point of the dependency-injection design:
 * the scoring engine can be exercised end-to-end against fixtures with no
 * database, no mocking library, and no test doubles generated at runtime.
 */

export class InMemoryAirportRepository implements IAirportRepository {
  private readonly airports: AirportsByCode;
  private readonly regions: RegionsById;

  constructor(airports: Airport[], regions: RegionDefinition[] = []) {
    this.airports = airports.reduce((accumulator: AirportsByCode, airport) => {
      accumulator[airport.iata] = airport;
      return accumulator;
    }, {});

    this.regions = regions.reduce((accumulator: RegionsById, region) => {
      accumulator[region.id] = region;
      return accumulator;
    }, {});
  }

  public GetByCode(iata: string) {
    return this.airports[iata.toUpperCase()] ?? null;
  }

  public GetManyByCode(codes: string[]) {
    return codes.reduce((accumulator: AirportsByCode, code) => {
      const airport = this.GetByCode(code);
      if (airport) accumulator[airport.iata] = airport;
      return accumulator;
    }, {});
  }

  public GetAll() {
    return this.airports;
  }

  public Find(filter: AirportFilter) {
    return Object.values(this.airports).filter((airport) => {
      if (filter.requiresOnTimeReporting && !airport.reportsOnTimePerformance) return false;
      if (filter.states && !filter.states.includes(airport.state)) return false;
      if (filter.hubClasses && !filter.hubClasses.includes(airport.hubClass)) return false;
      if (filter.iataCodes && !filter.iataCodes.includes(airport.iata)) return false;
      return true;
    });
  }

  public FindWithinRadius() {
    return Object.values(this.airports);
  }

  public SearchByText(query: string, limit: number) {
    const needle = query.toLowerCase();
    return Object.values(this.airports)
      .filter((airport) => airport.name.toLowerCase().includes(needle) || airport.iata.toLowerCase() === needle)
      .slice(0, limit);
  }

  public GetRegions() {
    return this.regions;
  }

  public GetRegion(regionId: string) {
    return this.regions[regionId] ?? null;
  }
}

export class InMemoryMetricRepository implements IMetricRepository {
  private readonly nested: MetricValuesByMetricAndAirport = {};

  constructor(rows: MetricValueRow[] = []) {
    this.Replace(rows);
  }

  public GetForAirports(codes: string[], metricIds: MetricId[]) {
    return metricIds.reduce((accumulator: MetricValuesByMetricAndAirport, metricId) => {
      const source = this.nested[metricId];
      if (!source) return accumulator;

      for (const code of codes) {
        if (source[code] === undefined) continue;
        const existing = accumulator[metricId];
        if (existing) existing[code] = source[code];
        else accumulator[metricId] = { [code]: source[code] };
      }
      return accumulator;
    }, {});
  }

  public GetAllForPeriod() {
    return this.nested;
  }

  public Replace(rows: MetricValueRow[]) {
    for (const key of Object.keys(this.nested)) delete this.nested[key];

    for (const row of rows) {
      const existing = this.nested[row.metricId];
      if (existing) existing[row.iata] = row.value;
      else this.nested[row.metricId] = { [row.iata]: row.value };
    }
  }
}

export class InMemoryFacilityRepository implements IFacilityRepository {
  private readonly records: FacilityRecordsByCode;

  constructor(records: AirportFacilityRecord[] = []) {
    this.records = records.reduce((accumulator: FacilityRecordsByCode, record) => {
      accumulator[record.iata] = record;
      return accumulator;
    }, {});
  }

  public GetByCode(iata: string) {
    return this.records[iata] ?? null;
  }

  public GetAll() {
    return this.records;
  }

  public CountCuratedGates() {
    return 0;
  }
}
