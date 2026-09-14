import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';

import { Caveats, DefaultPeriodId } from './ToolContext';
import type { ToolContext } from './ToolContext';

/**
 * Secondary-airport plays.
 *
 * A thin adapter over ReliefAnalyzer, which holds the headroom logic in the
 * domain layer where it is unit tested.
 */

const InputSchema = z.object({
  iata: z.string().describe('The constrained airport to find alternatives for, e.g. "LAX".'),
  radiusKm: z.number().optional().describe('Search radius in km. Defaults to 150.'),
});

export function CreateFindReliefAirportsTool(context: ToolContext) {
  return betaZodTool({
    name: 'find_relief_airports',
    description:
      'Find nearby airports that could absorb overflow from a constrained one - the secondary-airport ' +
      'investment thesis (buy Ontario rather than fight for Los Angeles slots). Returns each neighbour with a ' +
      'headroom score and the evidence behind it. Use for "what is the alternative to X", "where does X spill to", ' +
      'or questions about secondary or reliever airports in a market.',
    inputSchema: InputSchema,
    run: async (input) => {
      const assessment = context.container.reliefAnalyzer.Assess(
        input.iata,
        DefaultPeriodId,
        input.radiusKm,
      );

      if (!assessment) {
        return JSON.stringify(
          context.Wrap(
            { found: false, note: `No US airport matches "${input.iata}".` },
            { sources: ['our_airports'] },
          ),
        );
      }

      return JSON.stringify(
        context.Wrap(
          {
            primary: {
              iata: assessment.primary.iata,
              name: assessment.primary.name,
              isConstrained: assessment.primary.isConstrained,
              assessment: assessment.primary.narrative,
              loadFactorPercent: Percent(assessment.primary.loadFactor),
              spillRatePercent: Percent(assessment.primary.spillRate),
              taxiOutP90Minutes: Round(assessment.primary.taxiOutP90),
            },
            radiusKm: assessment.radiusKm,
            summary: assessment.narrative,
            candidates: assessment.candidates.map((candidate) => ({
              iata: candidate.iata,
              name: candidate.name,
              hubClass: candidate.hubClass,
              distanceKm: candidate.distanceKm,
              annualPassengers: candidate.annualPassengers,
              headroomScore: candidate.headroomScore,
              isViable: candidate.isViable,
              expansionScore: candidate.expansionScore,
              loadFactorPercent: Percent(candidate.loadFactor),
              taxiOutP90Minutes: Round(candidate.taxiOutP90),
              evidence: candidate.evidence.map((entry) => entry.narrative),
            })),
          },
          {
            sources: ['t100_socrata', 'bts_otp', 'curated', 'derived'],
            caveats: [...assessment.caveats, Caveats.noCostData],
          },
        ),
      );
    },
  });
}

function Percent(value: number | null) {
  return value === null ? null : Number((value * 100).toFixed(1));
}

function Round(value: number | null) {
  return value === null ? null : Number(value.toFixed(1));
}
