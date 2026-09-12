import { readFileSync } from 'node:fs';

import { AirportCodeResolver } from '../AirportCodeResolver';
import { CuratedFacilitiesPath, RegionsPath } from '../../Config/Paths';
import type { CuratedFacilitiesFile } from '../../Types/Domain/Facility';
import type { IIngestSource, IngestContext, IngestOutcome } from '../../Types/Ports/IngestSources';
import type { ILogger } from '../../Types/Ports/Logger';
import type { RegionsFile } from '../../Types/Domain/Region';
import type { SqliteConnection } from '../../Infrastructure/Database/SqliteConnection';

/**
 * Loads the hand-curated files into the snapshot.
 *
 * Runs last, because facility rows reference airports that earlier sources
 * create. Regions are stored as data rather than left to the model to
 * interpret, so "New England" resolves to the same six states every time.
 *
 * Only airports explicitly listed in AirportFacilities.json get a row.
 * Absence is meaningful here: it is how the system represents "we have no
 * verified gate count for this airport", which downstream becomes a specific
 * exclusion reason rather than a silent zero.
 */
export class CuratedDataSource implements IIngestSource {
  public readonly sourceId = 'curated' as const;
  public readonly label = 'Curated regions and facility data';
  public readonly order = 40;

  private readonly database: SqliteConnection;
  private readonly logger: ILogger;

  constructor(database: SqliteConnection, logger: ILogger) {
    this.database = database;
    this.logger = logger;
  }

  public async Run(_context: IngestContext) {
    const startedAt = Date.now();
    const warnings: string[] = [];

    const regionCount = this.LoadRegions();
    const { facilityCount, gateCount, unmatched } = this.LoadFacilities();

    for (const code of unmatched) {
      warnings.push(`Curated facility entry "${code}" does not match any airport in the snapshot and was skipped.`);
    }

    this.logger.Info('Curated data loaded', { regions: regionCount, facilities: facilityCount, gateCounts: gateCount });

    const outcome: IngestOutcome = {
      sourceId: this.sourceId,
      rowsWritten: regionCount + facilityCount,
      coverageThrough: 'curated',
      durationMs: Date.now() - startedAt,
      warnings,
    };
    return outcome;
  }

  private LoadRegions() {
    const file = JSON.parse(readFileSync(RegionsPath, 'utf8')) as RegionsFile;

    const insert = this.database.Prepare<unknown>(`
      INSERT INTO regions (region_id, label, aliases, states)
      VALUES (@regionId, @label, @aliases, @states)
      ON CONFLICT(region_id) DO UPDATE SET
        label   = excluded.label,
        aliases = excluded.aliases,
        states  = excluded.states
    `);

    this.database.Transaction(() => {
      for (const region of file.regions) {
        insert.run({
          regionId: region.id,
          label: region.label,
          aliases: JSON.stringify(region.aliases),
          states: JSON.stringify(region.states),
        });
      }
    });

    return file.regions.length;
  }

  private LoadFacilities() {
    const file = JSON.parse(readFileSync(CuratedFacilitiesPath, 'utf8')) as CuratedFacilitiesFile;
    const resolver = AirportCodeResolver.FromDatabase(this.database);
    const defaults = file.defaults.feasibility;

    const insert = this.database.Prepare<unknown>(`
      INSERT INTO facilities (
        iata, gate_count, gate_source_url, gate_retrieved_date, gate_note,
        hourly_capacity, hourly_capacity_source, hourly_capacity_date,
        runway_count, runway_source_url, runway_retrieved_date,
        slot_controlled, perimeter_rule, land_constrained
      ) VALUES (
        @iata, @gateCount, @gateSourceUrl, @gateRetrievedDate, @gateNote,
        @hourlyCapacity, @hourlyCapacitySource, @hourlyCapacityDate,
        @runwayCount, @runwaySourceUrl, @runwayRetrievedDate,
        @slotControlled, @perimeterRule, @landConstrained
      )
      ON CONFLICT(iata) DO UPDATE SET
        gate_count             = excluded.gate_count,
        gate_source_url        = excluded.gate_source_url,
        gate_retrieved_date    = excluded.gate_retrieved_date,
        gate_note              = excluded.gate_note,
        hourly_capacity        = excluded.hourly_capacity,
        hourly_capacity_source = excluded.hourly_capacity_source,
        hourly_capacity_date   = excluded.hourly_capacity_date,
        runway_count           = excluded.runway_count,
        runway_source_url      = excluded.runway_source_url,
        runway_retrieved_date  = excluded.runway_retrieved_date,
        slot_controlled        = excluded.slot_controlled,
        perimeter_rule         = excluded.perimeter_rule,
        land_constrained       = excluded.land_constrained
    `);

    const unmatched: string[] = [];
    let facilityCount = 0;
    let gateCount = 0;

    this.database.Transaction(() => {
      for (const entry of file.airports) {
        const iata = resolver.Resolve(entry.iata);
        if (!iata) {
          unmatched.push(entry.iata);
          continue;
        }

        const feasibility = { ...defaults, ...(entry.feasibility ?? {}) };
        if (entry.gates) gateCount += 1;

        insert.run({
          iata,
          gateCount: entry.gates?.count ?? null,
          gateSourceUrl: entry.gates?.sourceUrl ?? null,
          gateRetrievedDate: entry.gates?.retrievedDate ?? null,
          gateNote: entry.gates?.note ?? null,
          hourlyCapacity: entry.hourlyCapacity?.count ?? null,
          hourlyCapacitySource: entry.hourlyCapacity?.sourceUrl ?? null,
          hourlyCapacityDate: entry.hourlyCapacity?.retrievedDate ?? null,
          runwayCount: entry.runways?.count ?? null,
          runwaySourceUrl: entry.runways?.sourceUrl ?? null,
          runwayRetrievedDate: entry.runways?.retrievedDate ?? null,
          slotControlled: feasibility.slotControlled ? 1 : 0,
          perimeterRule: feasibility.perimeterRule ? 1 : 0,
          landConstrained: feasibility.landConstrained ? 1 : 0,
        });
        facilityCount += 1;
      }
    });

    return { facilityCount, gateCount, unmatched };
  }
}
