import type { Airport, AirportsByCode, HubClass } from '../Types/Domain/Airport';
import type { AirportFilter, IAirportRepository } from '../Types/Ports/Repositories';
import type { RegionDefinition, RegionsById } from '../Types/Domain/Region';
import type { SqliteConnection } from '../Infrastructure/Database/SqliteConnection';

interface RawAirportRow {
  iata: string;
  icao: string | null;
  name: string;
  municipality: string;
  state: string;
  latitude: number | null;
  longitude: number | null;
  hubClass: string;
  annualEnplanements: number;
  enplanementShare: number;
  reportsOtp: number;
}

interface RawRegionRow {
  regionId: string;
  label: string;
  aliases: string;
  states: string;
}

const SelectColumns = `
  iata, icao, name, municipality, state, latitude, longitude,
  hub_class           AS hubClass,
  annual_enplanements AS annualEnplanements,
  enplanement_share   AS enplanementShare,
  reports_otp         AS reportsOtp
`;

const EarthRadiusKm = 6371;

export class SqliteAirportRepository implements IAirportRepository {
  private readonly database: SqliteConnection;

  constructor(database: SqliteConnection) {
    this.database = database;
  }

  public GetByCode(iata: string) {
    const row = this.database
      .Prepare<RawAirportRow>(`SELECT ${SelectColumns} FROM airports WHERE iata = ?`)
      .get(iata.toUpperCase());
    if (row) return this.ToAirport(row);

    // Fall back through the alias table so BTS-era codes still resolve.
    const viaAlias = this.database
      .Prepare<RawAirportRow>(
        `SELECT ${SelectColumns} FROM airports
          WHERE iata = (SELECT iata FROM airport_aliases WHERE alias = ?)`,
      )
      .get(iata.toUpperCase());
    return viaAlias ? this.ToAirport(viaAlias) : null;
  }

  public GetManyByCode(codes: string[]) {
    return codes.reduce((accumulator: AirportsByCode, code) => {
      const airport = this.GetByCode(code);
      if (airport) accumulator[airport.iata] = airport;
      return accumulator;
    }, {});
  }

  public GetAll() {
    const rows = this.database.Prepare<RawAirportRow>(`SELECT ${SelectColumns} FROM airports`).all();
    return rows.reduce((accumulator: AirportsByCode, row) => {
      accumulator[row.iata] = this.ToAirport(row);
      return accumulator;
    }, {});
  }

  public Find(filter: AirportFilter) {
    const clauses: string[] = [];
    const parameters: (string | number)[] = [];

    const states = filter.regionId ? this.GetRegion(filter.regionId)?.states ?? [] : filter.states ?? [];
    if (states.length > 0) {
      clauses.push(`state IN (${new Array(states.length).fill('?').join(',')})`);
      parameters.push(...states);
    }

    if (filter.hubClasses && filter.hubClasses.length > 0) {
      clauses.push(`hub_class IN (${new Array(filter.hubClasses.length).fill('?').join(',')})`);
      parameters.push(...filter.hubClasses);
    }

    if (filter.iataCodes && filter.iataCodes.length > 0) {
      clauses.push(`iata IN (${new Array(filter.iataCodes.length).fill('?').join(',')})`);
      parameters.push(...filter.iataCodes.map((code) => code.toUpperCase()));
    }

    if (filter.requiresOnTimeReporting) clauses.push('reports_otp = 1');

    // Only airports with reported traffic are meaningful candidates.
    clauses.push('annual_enplanements > 0');

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database
      .Prepare<RawAirportRow>(`SELECT ${SelectColumns} FROM airports ${where} ORDER BY annual_enplanements DESC`)
      .all(...parameters);

    return rows.map((row) => this.ToAirport(row));
  }

  /** Great-circle filter for metro-area questions that state boundaries cannot express. */
  public FindWithinRadius(latitude: number, longitude: number, radiusKm: number) {
    const candidates = this.Find({});
    return candidates.filter((airport) => {
      if (airport.latitude === null || airport.longitude === null) return false;
      return this.HaversineKm(latitude, longitude, airport.latitude, airport.longitude) <= radiusKm;
    });
  }

  public SearchByText(query: string, limit: number) {
    const pattern = `%${query.trim().toLowerCase()}%`;
    const rows = this.database
      .Prepare<RawAirportRow>(
        `SELECT ${SelectColumns} FROM airports
          WHERE annual_enplanements > 0
            AND (LOWER(name) LIKE ? OR LOWER(municipality) LIKE ? OR LOWER(iata) = LOWER(?))
       ORDER BY annual_enplanements DESC
          LIMIT ?`,
      )
      .all(pattern, pattern, query.trim(), limit);
    return rows.map((row) => this.ToAirport(row));
  }

  public GetRegions() {
    const rows = this.database
      .Prepare<RawRegionRow>('SELECT region_id AS regionId, label, aliases, states FROM regions')
      .all();
    return rows.reduce((accumulator: RegionsById, row) => {
      accumulator[row.regionId] = this.ToRegion(row);
      return accumulator;
    }, {});
  }

  public GetRegion(regionId: string) {
    const row = this.database
      .Prepare<RawRegionRow>(
        'SELECT region_id AS regionId, label, aliases, states FROM regions WHERE region_id = ?',
      )
      .get(regionId);
    return row ? this.ToRegion(row) : null;
  }

  private ToAirport(row: RawAirportRow) {
    const airport: Airport = {
      iata: row.iata,
      icao: row.icao,
      name: row.name,
      municipality: row.municipality,
      state: row.state,
      latitude: row.latitude ?? 0,
      longitude: row.longitude ?? 0,
      hubClass: row.hubClass as HubClass,
      annualEnplanements: row.annualEnplanements,
      enplanementShare: row.enplanementShare,
      reportsOnTimePerformance: row.reportsOtp === 1,
    };
    return airport;
  }

  private ToRegion(row: RawRegionRow) {
    const region: RegionDefinition = {
      id: row.regionId,
      label: row.label,
      aliases: JSON.parse(row.aliases) as string[],
      states: JSON.parse(row.states) as string[],
    };
    return region;
  }

  private HaversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
    const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
    const deltaLat = toRadians(lat2 - lat1);
    const deltaLon = toRadians(lon2 - lon1);
    const a =
      Math.sin(deltaLat / 2) ** 2 +
      Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLon / 2) ** 2;
    return 2 * EarthRadiusKm * Math.asin(Math.sqrt(a));
  }
}
