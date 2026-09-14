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
  airportCodes: string | null;
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
  private readonly minAnnualPassengers: number;

  constructor(database: SqliteConnection, minAnnualPassengers = 0) {
    this.database = database;
    this.minAnnualPassengers = minAnnualPassengers;
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

    const region = filter.regionId ? this.GetRegion(filter.regionId) : null;

    // A metro area is defined by an explicit airport list rather than states.
    if (region && region.airportCodes.length > 0) {
      clauses.push(`iata IN (${new Array(region.airportCodes.length).fill('?').join(',')})`);
      parameters.push(...region.airportCodes);
    }

    const states = region ? region.states : filter.states ?? [];
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

    // Passenger floor, not merely "> 0". General-aviation fields report a
    // handful of charter passengers a year and are not investment
    // candidates: an Atlanta metro ranking otherwise returned Gwinnett
    // County (12 annual passengers) beside Hartsfield-Jackson.
    clauses.push('annual_enplanements >= ?');
    parameters.push(filter.minAnnualPassengers ?? this.minAnnualPassengers);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limitClause = filter.limit && filter.limit > 0 ? ' LIMIT ?' : '';
    if (limitClause) parameters.push(filter.limit as number);

    const rows = this.database
      .Prepare<RawAirportRow>(
        `SELECT ${SelectColumns} FROM airports ${where} ORDER BY annual_enplanements DESC${limitClause}`,
      )
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

  /**
   * Text search over airport and city names.
   *
   * Matches at WORD BOUNDARIES, not anywhere in the string. A plain substring
   * search makes short queries useless: "LA" matched At-la-nta, Dal-la-s and
   * Or-la-ndo ahead of LAX. Requiring the query to start a word fixes that
   * without needing a full-text index.
   */
  public SearchByText(query: string, limit: number) {
    const needle = query.trim().toLowerCase();
    const startsWith = `${needle}%`;
    const wordStart = `% ${needle}%`;

    const rows = this.database
      .Prepare<RawAirportRow>(
        `SELECT ${SelectColumns} FROM airports
          WHERE annual_enplanements > 0
            AND (
              LOWER(iata) = ?
              OR LOWER(name) LIKE ?         -- name begins with the query
              OR LOWER(name) LIKE ?         -- query begins a word in the name
              OR LOWER(municipality) LIKE ?
              OR LOWER(municipality) LIKE ?
            )
       ORDER BY annual_enplanements DESC
          LIMIT ?`,
      )
      .all(needle, startsWith, wordStart, startsWith, wordStart, limit);

    return rows.map((row) => this.ToAirport(row));
  }

  /** Matches a colloquial place name to a region or metro area. */
  public FindRegionByAlias(query: string) {
    const needle = query.trim().toLowerCase();

    return Object.values(this.GetRegions()).find(
      (region) => region.id === needle || region.aliases.includes(needle) || region.label.toLowerCase() === needle,
    ) ?? null;
  }

  public GetRegions() {
    const rows = this.database
      .Prepare<RawRegionRow>('SELECT region_id AS regionId, label, aliases, states, airport_codes AS airportCodes FROM regions')
      .all();
    return rows.reduce((accumulator: RegionsById, row) => {
      accumulator[row.regionId] = this.ToRegion(row);
      return accumulator;
    }, {});
  }

  public GetRegion(regionId: string) {
    const row = this.database
      .Prepare<RawRegionRow>(
        'SELECT region_id AS regionId, label, aliases, states, airport_codes AS airportCodes FROM regions WHERE region_id = ?',
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
      airportCodes: JSON.parse(row.airportCodes ?? '[]') as string[],
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
