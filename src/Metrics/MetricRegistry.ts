import type { MetricDefinition, MetricDefinitionsById, MetricId } from '../Types/Domain/Metric';
import type { ScoredPillarId } from '../Types/Scoring/Pillar';

/**
 * The metric vocabulary, with the provenance and direction of each.
 *
 * DIRECTION IS READ FROM THE INVESTOR'S ANGLE, NOT THE TRAVELLER'S.
 * Long taxi-out times are miserable for passengers but they are precisely
 * what an expansion thesis is hunting for, so they score as higher_is_better.
 * The single exception is epc_gap, where a negative residual means the
 * catchment is under-served relative to its peers — that is the opportunity.
 *
 * PROVENANCE MATTERS. The agent must never present a modeled spill estimate
 * with the same confidence as a measured BTS figure, and the system prompt
 * enforces that distinction using this field.
 *
 * Weights here are registry defaults; the active profile in ScoringConfig.json
 * overrides them per metric.
 */

const definitions: MetricDefinition[] = [
  // --- Constraint ---------------------------------------------------------
  {
    id: 'taxi_out_p50',
    pillar: 'constraint',
    label: 'Median taxi-out time',
    description:
      'Typical minutes from pushback to wheels-off. The canonical measure of airfield queueing: when runways saturate, aircraft wait in line on the taxiway.',
    unit: 'minutes',
    direction: 'higher_is_better',
    provenance: 'measured',
    source: 'bts_otp',
    weight: 1.5,
  },
  {
    id: 'taxi_out_p90',
    pillar: 'constraint',
    label: '90th percentile taxi-out time',
    description:
      'Taxi-out on the worst 10% of departures. Captures how bad the peaks get, which is what drives airline scheduling decisions more than the median does.',
    unit: 'minutes',
    direction: 'higher_is_better',
    provenance: 'measured',
    source: 'bts_otp',
    weight: 1.5,
  },
  {
    id: 'dep_delay_15_rate',
    pillar: 'constraint',
    label: 'Share of departures delayed 15+ minutes',
    description: 'Proportion of domestic departures leaving at least 15 minutes behind schedule.',
    unit: 'ratio',
    direction: 'higher_is_better',
    provenance: 'measured',
    source: 'bts_otp',
    weight: 1.5,
  },
  {
    id: 'nas_delay_share',
    pillar: 'constraint',
    label: 'System-cause share of delay minutes',
    description:
      'Delay minutes attributed to National Airspace System causes (volume, runway capacity, ATC) as a share of all delay minutes. The key discriminator: it separates congestion caused by saturated infrastructure, which capital can fix, from congestion caused by weather, which it cannot.',
    unit: 'ratio',
    direction: 'higher_is_better',
    provenance: 'measured',
    source: 'bts_otp',
    weight: 2.0,
  },
  {
    id: 'peak_hour_passengers',
    pillar: 'constraint',
    label: 'Peak-hour passenger throughput',
    description:
      'Estimated passengers departing in the busiest hour, the measure terminals are actually sized against. Computed as peak-hour domestic departures multiplied by domestic passengers per departure. Domestic only, because BTS on-time reporting does not cover international segments — mixing in international traffic would overstate JFK by 28%.',
    unit: 'passengers',
    direction: 'higher_is_better',
    provenance: 'modeled',
    source: 'derived',
    weight: 2.0,
  },
  {
    id: 'seats_per_departure_trend',
    pillar: 'constraint',
    label: 'Aircraft upgauging trend',
    description:
      'Year-over-year change in average seats per domestic departure. When airlines cannot add flights they fly bigger aircraft instead, which pressures gates, holdrooms and baggage systems before it pressures runways — an early warning specific to terminal investment. Domestic basis: blending international widebodies distorts this by up to 24%.',
    unit: 'ratio',
    direction: 'higher_is_better',
    provenance: 'measured',
    source: 't100_socrata',
    weight: 1.5,
  },

  // --- Latent demand ------------------------------------------------------
  {
    id: 'enplanement_cagr_3y',
    pillar: 'latent_demand',
    label: '3-year passenger growth rate',
    description: 'Compound annual growth in enplaned passengers over the last three full years.',
    unit: 'ratio',
    direction: 'higher_is_better',
    provenance: 'measured',
    source: 't100_socrata',
    weight: 2.0,
  },
  {
    id: 'seat_cagr_3y',
    pillar: 'latent_demand',
    label: '3-year seat capacity growth rate',
    description:
      'Compound annual growth in scheduled seats. Read against passenger growth it shows whether airlines are able to keep pace with demand.',
    unit: 'ratio',
    direction: 'higher_is_better',
    provenance: 'measured',
    source: 't100_socrata',
    weight: 1.5,
  },
  {
    id: 'avg_load_factor',
    pillar: 'latent_demand',
    label: 'Average load factor',
    description: 'Passengers carried as a share of seats flown. High sustained load factors mean aircraft are full and demand has nowhere to go.',
    unit: 'ratio',
    direction: 'higher_is_better',
    provenance: 'measured',
    source: 't100_socrata',
    weight: 2.0,
  },
  {
    id: 'pct_months_lf_gt_85',
    pillar: 'latent_demand',
    label: 'Months above 85% load factor',
    description:
      'Share of months where load factor exceeded 85%. Persistence matters more than the average: an airport full every month is constrained, one full only in July is seasonal.',
    unit: 'ratio',
    direction: 'higher_is_better',
    provenance: 'measured',
    source: 't100_socrata',
    weight: 1.5,
  },
  {
    id: 'spill_rate',
    pillar: 'latent_demand',
    label: 'Estimated spill rate',
    description:
      'Share of latent demand turned away because aircraft were full, from a standard airline spill model. A lower bound: it cannot see passengers recaptured on other flights or at nearby airports.',
    unit: 'ratio',
    direction: 'higher_is_better',
    provenance: 'modeled',
    source: 'derived',
    weight: 2.0,
  },
  // --- Monetization -------------------------------------------------------
  {
    id: 'intl_pax_share',
    pillar: 'monetization',
    label: 'International passenger share',
    description:
      'Share of departing passengers on international itineraries. International traffic carries higher landing fees and concession spend, and drives federal inspection facility requirements — a classic terminal capital line item.',
    unit: 'ratio',
    direction: 'higher_is_better',
    provenance: 'measured',
    source: 't100_socrata',
    weight: 2.0,
  },
  {
    id: 'long_haul_share',
    pillar: 'monetization',
    label: 'Long-haul flight share',
    description:
      'Share of domestic departures over 2,200 statute miles. Long-haul passengers dwell longer airside and spend more. Domestic only, because BTS on-time reporting does not cover international segments.',
    unit: 'ratio',
    direction: 'higher_is_better',
    provenance: 'measured',
    source: 'bts_otp',
    weight: 1.5,
  },
  {
    id: 'avg_passenger_trip_miles',
    pillar: 'monetization',
    label: 'Average passenger journey length',
    description:
      'Average distance flown per departing passenger. Longer journeys carry higher fares and longer airside dwell, which is what drives concession and lounge revenue. Published directly by T-100 and covers international traffic, unlike the domestic-only long-haul share.',
    unit: 'index',
    direction: 'higher_is_better',
    provenance: 'measured',
    source: 't100_socrata',
    weight: 1.5,
  },
];

export const MetricsById: MetricDefinitionsById = definitions.reduce(
  (accumulator: MetricDefinitionsById, definition) => {
    accumulator[definition.id] = definition;
    return accumulator;
  },
  {},
);

export const AllMetricIds: MetricId[] = definitions.map((definition) => definition.id);

const idsByPillar = definitions.reduce((accumulator: MetricIdsByPillar, definition) => {
  const pillar = definition.pillar as ScoredPillarId;
  const existing = accumulator[pillar] ?? [];
  existing.push(definition.id);
  accumulator[pillar] = existing;
  return accumulator;
}, {});

export function GetMetricsForPillar(pillarId: ScoredPillarId) {
  return idsByPillar[pillarId] ?? [];
}

export function GetMetric(metricId: MetricId) {
  const definition = MetricsById[metricId];
  if (!definition) throw new Error(`Unknown metric: ${metricId}`);
  return definition;
}

interface MetricIdsByPillar {
  [pillarId: string]: MetricId[];
}
