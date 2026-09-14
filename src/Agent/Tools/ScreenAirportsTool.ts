import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';

import { AllMetricIds, MetricsById } from '../../Metrics/MetricRegistry';
import { Caveats, DefaultPeriodId } from './ToolContext';
import type { HubClass } from '../../Types/Domain/Airport';
import type { MetricId } from '../../Types/Domain/Metric';
import type { ToolContext } from './ToolContext';

/**
 * Ranks the whole universe by a SINGLE metric.
 *
 * Complements rank_airports, which sorts by the composite score. Screening
 * answers a different shape of question — "which airports grew fastest",
 * "which are most congested", "where are aircraft fullest" — where the user
 * wants one dimension, not the investment thesis.
 *
 * Kept separate rather than bolted onto rank_airports because the outputs
 * mean different things: a screen is a fact about one measurement, a ranking
 * is a judgement combining fourteen.
 */

const InputSchema = z.object({
  metric: z
    .enum(AllMetricIds as [MetricId, ...MetricId[]])
    .describe(
      'Which metric to rank by. Examples: "enplanement_cagr_3y" for passenger growth, "taxi_out_p90" for ' +
        'congestion severity, "avg_load_factor" for how full aircraft are, "spill_rate" for unmet demand, ' +
        '"nas_delay_share" for how much congestion is infrastructure rather than weather.',
    ),
  direction: z
    .enum(['highest', 'lowest'])
    .optional()
    .describe('Sort order. Defaults to "highest", which is the stronger investment signal for most metrics.'),
  regionId: z.string().optional().describe('Restrict to a named region or metro area.'),
  state: z.string().optional().describe('Restrict to a two-letter state code.'),
  hubClasses: z
    .array(z.enum(['Large', 'Medium', 'Small', 'Nonhub']))
    .optional()
    .describe('Restrict to FAA hub sizes, e.g. ["Medium","Small"] for secondary markets.'),
  minAnnualPassengers: z
    .number()
    .optional()
    .describe('Annual passenger floor. Raise it to exclude small airports where percentage changes are volatile.'),
  topN: z.number().optional().describe('How many to return. Defaults to 10.'),
});

const DefaultTopN = 10;

export function CreateScreenAirportsTool(context: ToolContext) {
  return betaZodTool({
    name: 'screen_airports',
    description:
      'Rank airports by ONE specific metric across the whole country, or within a region, state or hub class. ' +
      'Use for questions about a single dimension - fastest passenger growth, most congested, fullest aircraft, ' +
      'largest unmet demand, highest international share. For "best investment candidates" use rank_airports instead, ' +
      'which combines all fourteen metrics into a score.',
    inputSchema: InputSchema,
    run: async (input) => {
      const definition = MetricsById[input.metric];
      const topN = input.topN ?? DefaultTopN;
      const direction = input.direction ?? 'highest';

      const candidates = context.container.airportRepository.Find({
        regionId: input.regionId,
        states: input.state ? [input.state.toUpperCase()] : undefined,
        hubClasses: input.hubClasses as HubClass[] | undefined,
        minAnnualPassengers: input.minAnnualPassengers,
      });

      const values = context.container.metricRepository.GetForAirports(
        candidates.map((airport) => airport.iata),
        [input.metric],
        DefaultPeriodId,
      );
      const byAirport = values[input.metric] ?? {};

      const scored = candidates.reduce((accumulator: ScreenRow[], airport) => {
        const value = byAirport[airport.iata];
        if (value === undefined) return accumulator;

        accumulator.push({
          iata: airport.iata,
          name: airport.name,
          state: airport.state,
          hubClass: airport.hubClass,
          annualPassengers: airport.annualEnplanements,
          value: Number(value.toFixed(4)),
        });
        return accumulator;
      }, []);

      scored.sort((left, right) => (direction === 'highest' ? right.value - left.value : left.value - right.value));

      const missingCount = candidates.length - scored.length;
      const caveats: string[] = [
        `Ranked by ${definition.label} alone. This is a single measurement, not the composite investment score - use rank_airports for that.`,
      ];

      if (definition.provenance === 'modeled') {
        caveats.push(`${definition.label} is modeled, not measured. Treat the ordering as indicative.`);
      }
      if (definition.source === 'bts_otp') caveats.push(Caveats.domesticOnly);
      if (missingCount > 0) {
        caveats.push(
          `${missingCount} of ${candidates.length} airports in scope have no value for this metric and were left out.`,
        );
      }
      // Percentage-change metrics are unstable on small bases, and a screen
      // sorts precisely for extremes - so the warning belongs here.
      if (input.metric.includes('cagr') || input.metric.includes('trend')) {
        caveats.push(
          'Growth rates are volatile at low-traffic airports, where a single new route can dominate the percentage. Consider raising minAnnualPassengers when interpreting the top of this list.',
        );
      }

      return JSON.stringify(
        context.Wrap(
          {
            metric: input.metric,
            metricLabel: definition.label,
            metricDescription: definition.description,
            unit: definition.unit,
            provenance: definition.provenance,
            direction,
            scopeConsidered: candidates.length,
            scopeWithValue: scored.length,
            results: scored.slice(0, topN).map((row, index) => ({ rank: index + 1, ...row })),
          },
          { sources: [definition.source, 'derived'], caveats },
        ),
      );
    },
  });
}

interface ScreenRow {
  iata: string;
  name: string;
  state: string;
  hubClass: string;
  annualPassengers: number;
  value: number;
}
