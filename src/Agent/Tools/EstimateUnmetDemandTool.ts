import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';

import { Caveats } from './ToolContext';
import type { ToolContext } from './ToolContext';

/**
 * Estimated demand an airport is turning away, and why.
 *
 * A thin adapter: the spill maths and the cause attribution both live in
 * UnmetDemandAnalyzer, in the domain layer where they are unit tested. This
 * file only translates arguments in and shapes the envelope out.
 */

const InputSchema = z.object({
  iata: z.string().describe('Airport code.'),
});

export function CreateEstimateUnmetDemandTool(context: ToolContext) {
  return betaZodTool({
    name: 'estimate_unmet_demand',
    description:
      'Estimate passengers an airport is turning away, using a standard airline spill model, and attribute ' +
      'the cause (seat-constrained, frequency-constrained, or congestion-suppressed). ' +
      'Always report this as a LOWER BOUND and say so.',
    inputSchema: InputSchema,
    run: async (input) => {
      const airport = context.container.airportRepository.GetByCode(input.iata);
      if (!airport) {
        return JSON.stringify(
          context.Wrap({ found: false, note: `No US airport matches "${input.iata}".` }, { sources: ['our_airports'] }),
        );
      }

      const assessment = context.container.unmetDemandAnalyzer.Assess({
        iata: airport.iata,
        airportName: airport.name,
        trafficFrom: context.recentTrafficRange.from,
        trafficTo: context.recentTrafficRange.to,
        congestionFrom: context.congestionRange.from,
        congestionTo: context.congestionRange.to,
      });

      if (!assessment) {
        return JSON.stringify(
          context.Wrap(
            { found: true, hasData: false, note: `No traffic data for ${airport.name} in this period.` },
            { sources: ['t100_socrata'], coverage: 0 },
          ),
        );
      }

      const monthly = Object.values(assessment.monthly).map((estimate) => ({
        month: estimate.monthKey,
        loadFactor: Number((estimate.observedLoadFactor * 100).toFixed(1)),
        spilledPassengers: Math.round(estimate.spilledPassengers),
        spillRate: Number((estimate.spillRate * 100).toFixed(1)),
      }));

      const peak = assessment.monthly[assessment.peakMonth];

      return JSON.stringify(
        context.Wrap(
          {
            iata: assessment.iata,
            name: assessment.airportName,
            window: assessment.periodLabel,
            estimatedSpilledPassengers: Math.round(assessment.totalSpilledPassengers),
            averageSpillRatePercent: Number((assessment.averageSpillRate * 100).toFixed(1)),
            peakMonth: assessment.peakMonth,
            peakMonthSpilledPassengers: peak ? Math.round(peak.spilledPassengers) : 0,
            peakMonthLoadFactorPercent: peak ? Number((peak.observedLoadFactor * 100).toFixed(1)) : 0,
            monthly,
            drivers: assessment.drivers.map((driver) => ({
              driver: driver.driver,
              narrative: driver.narrative,
              supportingMetrics: driver.supportingMetrics,
            })),
            model: {
              name: 'Belobaba / Boeing airline spill model',
              kFactor: context.container.config.spill.kFactor,
              method:
                'Latent demand is assumed normally distributed with standard deviation k x mean; observed boardings equal E[min(demand, seats)]; the equation is inverted numerically to recover demand.',
            },
          },
          {
            sources: ['t100_socrata', 'bts_otp', 'derived'],
            caveats: [...assessment.caveats, Caveats.spillLowerBound, Caveats.noCostData],
          },
        ),
      );
    },
  });
}
