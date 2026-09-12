import type { AirportFacilityRecord, FacilityRecordsByCode } from '../Types/Domain/Facility';
import type { IFacilityRepository } from '../Types/Ports/Repositories';
import type { SqliteConnection } from '../Infrastructure/Database/SqliteConnection';

interface RawFacilityRow {
  iata: string;
  gateCount: number | null;
  gateSourceUrl: string | null;
  gateRetrievedDate: string | null;
  slotControlled: number;
  perimeterRule: number;
  landConstrained: number;
}

const SelectColumns = `
  iata,
  gate_count          AS gateCount,
  gate_source_url     AS gateSourceUrl,
  gate_retrieved_date AS gateRetrievedDate,
  slot_controlled     AS slotControlled,
  perimeter_rule      AS perimeterRule,
  land_constrained    AS landConstrained
`;

/**
 * Curated facility data.
 *
 * Absence is meaningful: an airport with no row simply has no regulatory
 * constraints recorded, which is the common case. Callers receive the
 * unconstrained defaults rather than a null they have to guard.
 */
export class SqliteFacilityRepository implements IFacilityRepository {
  private readonly database: SqliteConnection;

  constructor(database: SqliteConnection) {
    this.database = database;
  }

  public GetByCode(iata: string) {
    const row = this.database
      .Prepare<RawFacilityRow>(`SELECT ${SelectColumns} FROM facilities WHERE iata = ?`)
      .get(iata);
    return row ? this.ToRecord(row) : null;
  }

  public GetAll() {
    const rows = this.database.Prepare<RawFacilityRow>(`SELECT ${SelectColumns} FROM facilities`).all();
    return rows.reduce((accumulator: FacilityRecordsByCode, row) => {
      accumulator[row.iata] = this.ToRecord(row);
      return accumulator;
    }, {});
  }

  public CountCuratedGates() {
    const row = this.database
      .Prepare<{ n: number }>('SELECT COUNT(*) AS n FROM facilities WHERE gate_count IS NOT NULL')
      .get();
    return row?.n ?? 0;
  }

  private ToRecord(row: RawFacilityRow) {
    const record: AirportFacilityRecord = {
      iata: row.iata,
      feasibility: {
        slotControlled: row.slotControlled === 1,
        perimeterRule: row.perimeterRule === 1,
        landConstrained: row.landConstrained === 1,
      },
    };

    if (row.gateCount !== null) {
      record.gateCount = {
        value: row.gateCount,
        sourceUrl: row.gateSourceUrl ?? '',
        retrievedDate: row.gateRetrievedDate ?? '',
      };
    }
    return record;
  }
}
