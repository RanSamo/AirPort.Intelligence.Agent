import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';

import { Caveats, DefaultPeriodId } from './ToolContext';
import type { Airport } from '../../Types/Domain/Airport';
import type { AirportFilter } from '../../Types/Ports/Repositories';
import type { ToolContext } from './ToolContext';

/**
 * The headline tool: deterministic ranking.
 *
 * The agent must never reorder these results. The ordering, the exclusions
 * and the score decomposition are all computed here; the model's job is to
 * narrate them, not to reproduce them.
 */

const InputSchema = z.object({
  iataCodes: z.array(z.string()).optional().describe('Explicit airport codes to rank.'),
  regionId: z.string().optional().describe('Named region, e.g. "new_england", or a metro such as "los_angeles".'),
  state: z.string().optional().describe('Two-letter state code.'),
  hubClasses: z
    .array(z.enum(['Large', 'Medium', 'Small', 'Nonhub']))
    .optional()
    .describe(
      'Restrict to FAA hub sizes. Use ["Medium","Small"] for questions about secondary or mid-size markets, ' +
        '["Large"] for major hubs. Combines with any geographic filter.',
    ),
  minAnnualPassengers: z
    .number()
    .optional()
    .describe('Annual passenger floor. Defaults to the commercial-service threshold; raise it to focus on larger airports.'),
  profile: z
    .enum(['terminal', 'airfield', 'balanced'])
    .optional()
    .describe(
      'Which capital project is being evaluated. "terminal" for gates/holdrooms/concessions questions, ' +
        '"airfield" for runway/taxiway/congestion questions, "balanced" when unstated.',
    ),
  aggregation: z
    .enum(['geometric', 'arithmetic'])
    .optional()
    .describe(
      'How Need and Payoff combine. Geometric (default) requires both to hold; arithmetic lets a strong ' +
        'pillar compensate for a weak one. Only change if the user asks.',
    ),
  scaleWeighting: z
    .enum(['none', 'moderate', 'strong'])
    .optional()
    .describe(
      'How much absolute passenger volume counts. "none" ranks on intensity relative to peers only; ' +
        '"moderate" (default) tilts toward larger airports; "strong" tilts harder.',
    ),
  topN: z.number().optional().describe('Limit results. Defaults to 10.'),
});

const DefaultTopN = 10;

export function CreateRankAirportsTool(context: ToolContext) {
  return betaZodTool({
    name: 'rank_airports',
    description:
      'Rank airports as expansion investment candidates using the deterministic scoring engine. ' +
      'Call with NO geographic filter to scan the whole country - use that for open questions like ' +
      '"where should we be looking" or "best opportunities in the US". Narrow with regionId, state, ' +
      'hubClasses, or explicit iataCodes. ' +
      'Returns scores, pillar breakdowns, confidence, and a specific reason for every airport excluded. ' +
      'NEVER reorder these results or compute your own ranking - this is the authoritative ordering.',
    inputSchema: InputSchema,
    run: async (input) => {
      const airports = SelectAirports(context, input);

      if (airports.length === 0) {
        return JSON.stringify(
          context.Wrap(
            { scores: [], note: 'No airports matched that filter. Try resolve_airports first.' },
            { sources: ['derived'] },
          ),
        );
      }

      const profile = input.profile ?? context.container.config.defaultProfile;
      const result = context.container.scoringEngine.Rank({
        airports,
        periodId: DefaultPeriodId,
        overrides: {
          profile,
          aggregation: input.aggregation,
          scaleWeighting: input.scaleWeighting,
        },
        topN: input.topN ?? DefaultTopN,
      });

      const caveats = [Caveats.cohortRelative, Caveats.noCostData];
      if (profile !== 'balanced') caveats.push(Caveats.domesticOnly);

      const worstCoverage = result.scores.reduce(
        (minimum, score) => Math.min(minimum, score.coverage),
        result.scores.length > 0 ? 1 : 0,
      );

      return JSON.stringify(
        context.Wrap(
          {
            profile,
            profileLabel: context.container.config.profiles[profile]?.label ?? profile,
            aggregation: input.aggregation ?? context.container.config.aggregation,
            scaleWeighting: input.scaleWeighting ?? context.container.config.scale.weighting,
            consideredCount: result.consideredCount,
            rankedCount: result.scores.length,
            excludedCount: result.exclusions.length,
            scores: result.scores.map((score) => ({
              rank: score.rank,
              iata: score.iata,
              name: score.airportName,
              score: Number(score.score.toFixed(1)),
              need: Number(score.need.toFixed(1)),
              payoff: Number(score.payoff.toFixed(1)),
              feasibilityMultiplier: Number(score.feasibilityMultiplier.toFixed(2)),
              materialityMultiplier: Number(score.scaleMultiplier.toFixed(2)),
              hubClass: score.hubClass,
              cohortPercentile: Number(score.cohortPercentile.toFixed(0)),
              confidence: score.confidence,
              coverage: Number(score.coverage.toFixed(2)),
            })),
            exclusions: result.exclusions.map((exclusion) => ({
              iata: exclusion.iata,
              name: exclusion.airportName,
              reason: exclusion.explanation,
            })),
          },
          {
            sources: ['bts_otp', 't100_socrata', 'curated', 'derived'],
            caveats,
            exclusions: result.exclusions,
            coverage: worstCoverage,
          },
        ),
      );
    },
  });
}

/**
 * Resolves the candidate set.
 *
 * With no geographic filter this returns the NATIONAL set rather than
 * nothing. "Where should we be looking?" is an analyst's opening question,
 * and previously it returned an empty result because every path required a
 * region, state or explicit code list.
 */
export function SelectAirports(context: ToolContext, input: z.infer<typeof InputSchema>) {
  const repository = context.container.airportRepository;
  const universe = context.container.config.universe;

  if (input.iataCodes && input.iataCodes.length > 0) {
    return Object.values(repository.GetManyByCode(input.iataCodes)) as Airport[];
  }

  const filter: AirportFilter = {
    hubClasses: input.hubClasses,
    minAnnualPassengers: input.minAnnualPassengers,
  };

  if (input.regionId) filter.regionId = input.regionId;
  else if (input.state) filter.states = [input.state.toUpperCase()];
  // National scan: capped so a single question does not score every airport
  // in the country and return an unreadable wall of results.
  else filter.limit = universe.nationalCandidateLimit;

  return repository.Find(filter);
}
