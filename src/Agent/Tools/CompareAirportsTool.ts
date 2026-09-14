import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';

import { Caveats, DefaultPeriodId } from './ToolContext';
import { AllMetricIds, GetMetricsForPillar, MetricsById } from '../../Metrics/MetricRegistry';
import type { MetricId } from '../../Types/Domain/Metric';
import type { ToolContext } from './ToolContext';

/**
 * Side-by-side comparison on shared metrics.
 *
 * Results are keyed metric -> airport -> value rather than returned as
 * parallel arrays, so the model cannot misalign columns when reading them.
 */

const InputSchema = z.object({
  iataCodes: z.array(z.string()).min(2).describe('Two or more airport codes to compare.'),
  dimension: z
    .enum(['congestion', 'demand', 'revenue', 'all'])
    .optional()
    .describe(
      'Which family of metrics to compare. "congestion" for delay/taxi questions, "demand" for growth and ' +
        'load factor, "revenue" for international and trip length. Defaults to "all".',
    ),
});

const DimensionToPillar: { [dimension: string]: string } = {
  congestion: 'constraint',
  demand: 'latent_demand',
  revenue: 'monetization',
};

export function CreateCompareAirportsTool(context: ToolContext) {
  return betaZodTool({
    name: 'compare_airports',
    description:
      'Compare two or more airports metric by metric, with the leader identified per metric. ' +
      'Use for "compare X and Y" questions. Values are keyed by metric then airport.',
    inputSchema: InputSchema,
    run: async (input) => {
      const { found, missing } = context.ResolveCodes(input.iataCodes);
      const airports = found.filter((airport) => airport !== null);

      if (airports.length < 2) {
        return JSON.stringify(
          context.Wrap(
            {
              note: 'Need at least two resolvable airports to compare.',
              unresolved: missing,
            },
            { sources: ['our_airports'] },
          ),
        );
      }

      const dimension = input.dimension ?? 'all';
      const metricIds: MetricId[] =
        dimension === 'all' ? AllMetricIds : GetMetricsForPillar(DimensionToPillar[dimension] as never);

      const codes = airports.map((airport) => airport.iata);
      const values = context.container.metricRepository.GetForAirports(codes, metricIds, DefaultPeriodId);

      const comparison = metricIds.reduce((accumulator: ComparisonGrid, metricId) => {
        const perAirport = values[metricId];
        if (!perAirport) return accumulator;

        const definition = MetricsById[metricId];
        const present = codes.filter((code) => perAirport[code] !== undefined);
        if (present.length === 0) return accumulator;

        // "Leader" means strongest investment signal, which for a metric like
        // taxi-out means the HIGHER value - congestion is what we are hunting.
        const leader = present.reduce((best, code) =>
          definition.direction === 'higher_is_better'
            ? perAirport[code] > perAirport[best]
              ? code
              : best
            : perAirport[code] < perAirport[best]
              ? code
              : best,
        );

        accumulator[metricId] = {
          label: definition.label,
          unit: definition.unit,
          pillar: definition.pillar,
          provenance: definition.provenance,
          strongerSignalMeans: definition.direction === 'higher_is_better' ? 'higher' : 'lower',
          values: present.reduce((byCode: { [code: string]: number }, code) => {
            byCode[code] = Number(perAirport[code].toFixed(4));
            return byCode;
          }, {}),
          leader,
          missingFor: codes.filter((code) => perAirport[code] === undefined),
        };
        return accumulator;
      }, {});

      const caveats = [Caveats.cohortRelative];
      if (dimension === 'congestion' || dimension === 'all') caveats.push(Caveats.domesticOnly);
      if (missing.length > 0) caveats.push(`Could not resolve: ${missing.join(', ')}.`);

      const differentCohorts = new Set(airports.map((airport) => airport.hubClass)).size > 1;
      if (differentCohorts) {
        caveats.push(
          'These airports are in different FAA hub-class cohorts, so raw metric values are directly comparable but scores are not - each score is relative to its own peer group.',
        );
      }

      return JSON.stringify(
        context.Wrap(
          {
            dimension,
            airports: airports.map((airport) => ({
              iata: airport.iata,
              name: airport.name,
              hubClass: airport.hubClass,
              annualPassengers: airport.annualEnplanements,
              hasCongestionData: airport.reportsOnTimePerformance,
            })),
            comparison,
          },
          { sources: ['bts_otp', 't100_socrata', 'derived'], caveats },
        ),
      );
    },
  });
}

interface ComparisonEntry {
  label: string;
  unit: string;
  pillar: string;
  provenance: string;
  strongerSignalMeans: string;
  values: { [iataCode: string]: number };
  leader: string;
  missingFor: string[];
}

interface ComparisonGrid {
  [metricId: string]: ComparisonEntry;
}
