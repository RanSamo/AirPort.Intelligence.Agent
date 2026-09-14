import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';

import { Caveats, DefaultPeriodId } from './ToolContext';
import { MetricsById } from '../../Metrics/MetricRegistry';
import type { ToolContext } from './ToolContext';

/**
 * Term-by-term account of why an airport scored what it did.
 *
 * The waterfall sums exactly to the final score by construction, so the
 * agent can narrate it without any reconciliation. The "Balance across
 * pillars" term makes the geometric penalty visible rather than mysterious.
 */

const InputSchema = z.object({
  iata: z.string().describe('Airport code to explain.'),
  profile: z.enum(['terminal', 'airfield', 'balanced']).optional(),
  aggregation: z.enum(['geometric', 'arithmetic']).optional(),
  scaleWeighting: z.enum(['none', 'moderate', 'strong']).optional(),
});

export function CreateExplainScoreTool(context: ToolContext) {
  return betaZodTool({
    name: 'explain_score',
    description:
      'Break an airport score into its contributing terms. Returns a waterfall that sums exactly to the ' +
      'final score, plus the individual metrics driving each pillar. Use whenever the user asks "why".',
    inputSchema: InputSchema,
    run: async (input) => {
      const airport = context.container.airportRepository.GetByCode(input.iata);
      if (!airport) {
        return JSON.stringify(
          context.Wrap({ found: false, note: `No US airport matches "${input.iata}".` }, { sources: ['our_airports'] }),
        );
      }

      const score = context.container.scoringEngine.ScoreOne(airport, DefaultPeriodId, {
        profile: input.profile,
        aggregation: input.aggregation,
        scaleWeighting: input.scaleWeighting,
      });

      if (!score) {
        return JSON.stringify(
          context.Wrap(
            {
              found: true,
              scored: false,
              note: `${airport.name} has too little data to score. Use get_airport_profile to see what is available.`,
            },
            { sources: ['derived'], coverage: 0 },
          ),
        );
      }

      const pillars = Object.values(score.pillars).map((pillar) => ({
        pillar: pillar.pillarId,
        score: Number(pillar.score.toFixed(1)),
        coverage: Number(pillar.coverage.ratio.toFixed(2)),
        missingMetrics: pillar.coverage.missingMetrics,
        drivers: [...pillar.contributions]
          .sort((left, right) => Math.abs(right.normalizedScore - 50) - Math.abs(left.normalizedScore - 50))
          .slice(0, 3)
          .map((contribution) => ({
            metric: MetricsById[contribution.metricId]?.label ?? contribution.metricId,
            rawValue: Number(contribution.rawValue.toFixed(4)),
            normalizedScore: Number(contribution.normalizedScore.toFixed(1)),
            weight: Number(contribution.effectiveWeight.toFixed(2)),
            provenance: MetricsById[contribution.metricId]?.provenance ?? 'derived',
          })),
      }));

      return JSON.stringify(
        context.Wrap(
          {
            iata: score.iata,
            name: score.airportName,
            finalScore: Number(score.score.toFixed(1)),
            hubClass: score.hubClass,
            cohortPercentile: Number(score.cohortPercentile.toFixed(0)),
            confidence: score.confidence,
            profile: score.profile,
            aggregation: score.aggregation,
            waterfall: score.waterfall.terms.map((term) => ({
              label: term.label,
              kind: term.kind,
              points: Number(term.amount.toFixed(1)),
              runningTotal: Number(term.runningTotal.toFixed(1)),
              why: term.narrative,
            })),
            waterfallTotal: Number(score.waterfall.total.toFixed(1)),
            pillars,
          },
          {
            sources: ['bts_otp', 't100_socrata', 'curated', 'derived'],
            caveats: [Caveats.cohortRelative, Caveats.noCostData],
            coverage: score.coverage,
          },
        ),
      );
    },
  });
}
