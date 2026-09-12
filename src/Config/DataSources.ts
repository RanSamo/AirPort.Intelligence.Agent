import type { DataSourceId } from '../Types/Data/Source';

/**
 * Upstream endpoints, verified reachable 2026-09-12.
 *
 * See CLAUDE.md section 4 for the sources that were investigated and found
 * unavailable (route-level T-100, O&D share, gate-count APIs) so they are not
 * re-investigated.
 */

const Day = 60 * 60 * 24;

export interface SourceEndpoint {
  sourceId: DataSourceId;
  label: string;
  url: string;
  ttlSeconds: number;
}

/** Airport identity and geography. ~12.7MB CSV. */
export const OurAirportsEndpoint: SourceEndpoint = {
  sourceId: 'our_airports',
  label: 'OurAirports reference data',
  url: 'https://davidmegginson.github.io/ourairports-data/airports.csv',
  ttlSeconds: 30 * Day,
};

/**
 * BTS T-100 Segment Summary by Origin Airport, via the Socrata SODA API.
 * Airport x month: departures, passengers, seats, load factor, and the
 * domestic / inbound-international / outbound-international split.
 * Coverage 2014-01 through 2026-04; 1,220 airports; ~131,700 rows total.
 */
export const T100SocrataEndpoint: SourceEndpoint = {
  sourceId: 't100_socrata',
  label: 'BTS T-100 Segment Summary by Origin Airport',
  url: 'https://data.transportation.gov/resource/r495-tyji.json',
  ttlSeconds: 7 * Day,
};

/** Socrata caps a single response; ingest pages through with $offset. */
export const T100PageSize = 50_000;

/**
 * BTS On-Time Performance monthly archives.
 * ~31MB zipped / ~275MB uncompressed / ~600k flight rows per month.
 * Coverage 1987-10 through 2026-06.
 */
export function BuildOtpArchiveUrl(year: number, month: number) {
  return `https://transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present_${year}_${month}.zip`;
}

export const OtpSourceMeta = {
  sourceId: 'bts_otp' as DataSourceId,
  label: 'BTS Reporting Carrier On-Time Performance',
  ttlSeconds: 30 * Day,
};

/** FAA NAS Status — live ground stops and delay programs. XML, no auth. */
export const FaaNasStatusEndpoint: SourceEndpoint = {
  sourceId: 'faa_nas_status',
  label: 'FAA National Airspace System Status',
  url: 'https://nasstatus.faa.gov/api/airport-status-information',
  ttlSeconds: 60,
};

/** OpenSky — optional live enrichment. Requires OAuth2 client credentials. */
export const OpenSkyTokenUrl =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

export function BuildOpenSkyDeparturesUrl(icao: string, beginEpoch: number, endEpoch: number) {
  return `https://opensky-network.org/api/flights/departure?airport=${icao}&begin=${beginEpoch}&end=${endEpoch}`;
}

/**
 * Distance bands for haul mix, in statute miles (BTS reports Distance in sm).
 * Long haul is set at 2,200sm so transcontinental US and most transoceanic
 * flying lands in the long bucket, which is the split an investor cares about
 * for wide-body gates and international facilities.
 */
export const HaulDistanceBands = {
  shortHaulMaxMiles: 700,
  mediumHaulMaxMiles: 2_199,
};
