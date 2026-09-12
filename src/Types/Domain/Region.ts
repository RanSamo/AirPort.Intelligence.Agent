import type { UsStateCode } from './Airport';

/**
 * Named geographic regions.
 *
 * "New England" is not in any data source, so colloquial regions are defined
 * explicitly as state sets. Keeping this as data rather than letting the LLM
 * decide what counts as New England keeps region queries reproducible.
 */
export type RegionId = string;

export interface RegionDefinition {
  id: RegionId;
  label: string;
  /** Alternative phrasings a user might type, lowercased. */
  aliases: string[];
  states: UsStateCode[];
}

export interface RegionsById {
  [regionId: string]: RegionDefinition;
}

/** Shape of Data/Curated/Regions.json. */
export interface RegionsFile {
  regions: RegionDefinition[];
}

/** Geographic proximity query, e.g. "airports within 100km of LAX". */
export interface ProximityQuery {
  latitude: number;
  longitude: number;
  radiusKm: number;
}
