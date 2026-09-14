import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';

import { DefaultPeriodId } from './ToolContext';
import { SelectAirports } from './RankAirportsTool';
import type { ToolContext } from './ToolContext';

/**
 * How much a ranking depends on the weights we chose.
 *
 * The agent should reach for this whenever it is about to present a close
 * ordering as if it were settled. Reporting `ties` is not optional: three of
 * the New England airports sit within 0.1 points of each other and swap
 * places in roughly half of plausible weightings.
 */

const InputSchema = z.object({
  iataCodes: z.array(z.string()).optional().describe('Explicit airport codes to test.'),
  regionId: z.string().optional().describe('Named region, e.g. "new_england".'),
  state: z.string().optional().describe('Two-letter state code.'),
  profile: z.enum(['terminal', 'airfield', 'balanced']).optional(),
  aggregation: z
    .enum(['geometric', 'arithmetic'])
    .optional()
    .describe(
      'Must match the aggregation used for the ranking being tested. If the user asked for arithmetic, ' +
        'pass it here too - otherwise the robustness figure describes a different ranking than the one shown.',
    ),
  scaleWeighting: z.enum(['none', 'moderate', 'strong']).optional(),
  topN: z.number().optional().describe('Size of the leading group to test. Defaults to 5.'),
});

export function CreateTestScoreSensitivityTool(context: ToolContext) {
  return betaZodTool({
    name: 'test_score_sensitivity',
    description:
      'Test whether a ranking is robust or an artefact of the chosen weights. Resamples every weight in the ' +
      'model hundreds of times and reports how often each airport holds its position, plus pairs that are ' +
      'statistically tied. Use this before presenting a close ranking as settled, and whenever the user ' +
      'asks how confident you are.',
    inputSchema: InputSchema,
    run: async (input) => {
      const airports = SelectAirports(context, input);
      if (airports.length < 2) {
        return JSON.stringify(
          context.Wrap(
            { note: 'Need at least two airports to test a ranking.' },
            { sources: ['derived'] },
          ),
        );
      }

      const result = context.container.sensitivityAnalyzer.Analyze({
        airports,
        periodId: DefaultPeriodId,
        overrides: {
          profile: input.profile,
          // Carried through so the robustness figure describes the same
          // ranking the user was shown. Omitting it silently tested the
          // default mode against an arithmetic ranking.
          aggregation: input.aggregation,
          scaleWeighting: input.scaleWeighting,
        },
        topN: input.topN,
      });

      return JSON.stringify(
        context.Wrap(
          {
            draws: result.draws,
            topN: result.topN,
            isRankingRobust: result.isRankingRobust,
            summary: result.narrative,
            distributions: result.distributions.slice(0, 12).map((entry) => ({
              iata: entry.iata,
              name: entry.airportName,
              baselineRank: entry.baselineRank,
              medianRank: entry.medianRank,
              bestRank: entry.bestRank,
              worstRank: entry.worstRank,
              percentInTopN: Number((entry.probabilityInTopN * 100).toFixed(0)),
              percentHoldingRank: Number((entry.probabilityAtBaselineRank * 100).toFixed(0)),
            })),
            ties: result.ties.map((tie) => ({
              airports: [tie.iata, tie.otherIata],
              swapPercent: Number((tie.swapRate * 100).toFixed(0)),
              note: tie.narrative,
            })),
            method: {
              technique: 'Monte Carlo simulation over the scoring weights',
              perturbs:
                'Both metric weights and the pillar structure (Constraint vs Latent Demand, Need vs Payoff). Perturbing only metric weights understates uncertainty.',
              distribution: `log-normal, sigma ${result.weightSpread} (roughly +/-40% per weight)`,
              seed: result.seed,
              reproducible: true,
            },
          },
          {
            sources: ['derived'],
            caveats: [
              'This measures sensitivity to the scoring weights only. It does not capture uncertainty in the underlying data.',
              result.ties.length > 0
                ? 'Report the tied pairs to the user. Presenting them in a fixed order would overstate what the data supports.'
                : 'No statistically tied pairs found in the leading group.',
            ],
          },
        ),
      );
    },
  });
}
