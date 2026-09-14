import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';

import { Caveats, DefaultPeriodId } from './ToolContext';
import { AllMetricIds, MetricsById } from '../../Metrics/MetricRegistry';
import type { ToolContext } from './ToolContext';

/**
 * Everything known about one airport.
 *
 * Works for ANY airport in the snapshot, including those excluded from
 * rankings for thin data. That is deliberate: an airport being unrankable
 * must never mean the user cannot ask about it.
 */

const InputSchema = z.object({
  iata: z.string().describe('Airport code, e.g. "BOS". Historic codes such as "PBI" resolve automatically.'),
});

export function CreateGetAirportProfileTool(context: ToolContext) {
  return betaZodTool({
    name: 'get_airport_profile',
    description:
      'Full profile for a single airport: identity, hub class, traffic, every computed metric, its score, ' +
      'and any regulatory constraints. Works even for airports excluded from rankings.',
    inputSchema: InputSchema,
    run: async (input) => {
      const airport = context.container.airportRepository.GetByCode(input.iata);
      if (!airport) {
        return JSON.stringify(
          context.Wrap(
            { found: false, note: `No US airport matches "${input.iata}". Try resolve_airports.` },
            { sources: ['our_airports'] },
          ),
        );
      }

      const metricValues = context.container.metricRepository.GetForAirports(
        [airport.iata],
        AllMetricIds,
        DefaultPeriodId,
      );

      const metrics = AllMetricIds.reduce((accumulator: MetricReadout[], metricId) => {
        const value = metricValues[metricId]?.[airport.iata];
        if (value === undefined) return accumulator;

        const definition = MetricsById[metricId];
        accumulator.push({
          metricId,
          label: definition.label,
          value: Number(value.toFixed(4)),
          unit: definition.unit,
          pillar: definition.pillar,
          provenance: definition.provenance,
        });
        return accumulator;
      }, []);

      const missingMetrics = AllMetricIds.filter(
        (metricId) => metricValues[metricId]?.[airport.iata] === undefined,
      );

      const score = context.container.scoringEngine.ScoreOne(airport, DefaultPeriodId, {});
      const facility = context.container.facilityRepository.GetByCode(airport.iata);

      const caveats = [Caveats.noCostData];
      if (!airport.reportsOnTimePerformance) {
        caveats.push(
          `${airport.name} is not covered by BTS On-Time Performance, so no congestion, taxi-time or peak-hour figures exist for it.`,
        );
      }
      if (missingMetrics.length > 0) {
        caveats.push(
          `${missingMetrics.length} of ${AllMetricIds.length} metrics are unavailable for this airport: ${missingMetrics.join(', ')}.`,
        );
      }

      return JSON.stringify(
        context.Wrap(
          {
            found: true,
            iata: airport.iata,
            icao: airport.icao,
            name: airport.name,
            city: airport.municipality,
            state: airport.state,
            hubClass: airport.hubClass,
            annualPassengers: airport.annualEnplanements,
            shareOfUsPassengers: Number((airport.enplanementShare * 100).toFixed(3)),
            hasCongestionData: airport.reportsOnTimePerformance,
            metrics,
            missingMetrics,
            score: score
              ? {
                  score: Number(score.score.toFixed(1)),
                  need: Number(score.need.toFixed(1)),
                  payoff: Number(score.payoff.toFixed(1)),
                  cohortPercentile: Number(score.cohortPercentile.toFixed(0)),
                  confidence: score.confidence,
                  coverage: Number(score.coverage.toFixed(2)),
                }
              : null,
            regulatoryConstraints: facility
              ? {
                  slotControlled: facility.feasibility.slotControlled,
                  perimeterRule: facility.feasibility.perimeterRule,
                  landConstrained: facility.feasibility.landConstrained,
                }
              : { slotControlled: false, perimeterRule: false, landConstrained: false },
          },
          {
            sources: ['our_airports', 't100_socrata', 'bts_otp', 'curated'],
            caveats,
            coverage: score?.coverage ?? 0,
          },
        ),
      );
    },
  });
}

interface MetricReadout {
  metricId: string;
  label: string;
  value: number;
  unit: string;
  pillar: string;
  provenance: string;
}
