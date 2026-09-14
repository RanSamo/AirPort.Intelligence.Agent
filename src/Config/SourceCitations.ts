import type { DataSourceId, SourceCitation } from '../Types/Data/Source';

/**
 * Provenance for every number the agent can report.
 *
 * `coverageThrough` is filled in at runtime from what the snapshot actually
 * holds, so a citation can never claim newer data than was ingested.
 */
const definitions: { [sourceId: string]: Omit<SourceCitation, 'coverageThrough'> } = {
  bts_otp: {
    sourceId: 'bts_otp',
    label: 'BTS Reporting Carrier On-Time Performance (domestic flights only)',
    url: 'https://transtats.bts.gov/PREZIP/',
  },
  t100_socrata: {
    sourceId: 't100_socrata',
    label: 'BTS T-100 Segment Summary by Origin Airport',
    url: 'https://data.transportation.gov/resource/r495-tyji.json',
  },
  our_airports: {
    sourceId: 'our_airports',
    label: 'OurAirports reference data',
    url: 'https://davidmegginson.github.io/ourairports-data/airports.csv',
  },
  faa_nas_status: {
    sourceId: 'faa_nas_status',
    label: 'FAA National Airspace System Status (live)',
    url: 'https://nasstatus.faa.gov/api/airport-status-information',
  },
  opensky: {
    sourceId: 'opensky',
    label: 'OpenSky Network (live, optional enrichment - never used for scoring)',
    url: 'https://opensky-network.org/',
  },
  curated: {
    sourceId: 'curated',
    label: 'Hand-curated regulatory constraints (FAA slot administration, perimeter rules)',
    url: 'https://www.faa.gov/air_traffic/publications/slot_administration',
  },
  derived: {
    sourceId: 'derived',
    label: 'Computed by this system from the sources above',
    url: '',
  },
};

export function BuildCitation(sourceId: DataSourceId, coverageThrough: string) {
  const definition = definitions[sourceId] ?? definitions.derived;
  const citation: SourceCitation = { ...definition, sourceId, coverageThrough };
  return citation;
}
