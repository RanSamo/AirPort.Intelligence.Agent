import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
// NOTE: 'zod/v4', not 'zod'. The SDK helper is typed against the v4 API, which
// zod 3.25 ships under this subpath. Importing from 'zod' gives the v3 classic
// types and every tool fails to typecheck.
import { z } from 'zod/v4';

import type { Airport } from '../../Types/Domain/Airport';
import type { AirportResolutionCandidate } from '../../Types/Domain/Airport';
import type { ToolContext } from './ToolContext';

/**
 * Turns free text into concrete airports.
 *
 * Deliberately reports ambiguity instead of resolving it. "LA" legitimately
 * means LAX, BUR, LGB or ONT, and picking one silently would produce a
 * confident answer to a question the user did not ask. The system prompt
 * requires the agent to ask when `isAmbiguous` is true.
 */

const InputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('Free text: an airport code, name, or city. Example: "Santa Ana", "LAX", "Boston".'),
  regionId: z
    .string()
    .optional()
    .describe('Named region, e.g. "new_england", "california", "pacific_northwest". Use list_regions semantics: call with no arguments to see all.'),
  state: z.string().optional().describe('Two-letter US state or territory code, e.g. "MA", "CA", "PR".'),
  nearIata: z.string().optional().describe('Find airports near this airport code, e.g. "LAX".'),
  radiusKm: z.number().optional().describe('Radius in km for nearIata. Defaults to 100.'),
  requiresCongestionData: z
    .boolean()
    .optional()
    .describe('Only return airports covered by BTS On-Time Performance, required for congestion questions.'),
  limit: z.number().optional().describe('Maximum results. Defaults to 25.'),
});

const DefaultRadiusKm = 100;
const DefaultLimit = 25;
/** Below this score gap, two candidates are treated as equally plausible. */
const AmbiguityGap = 0.15;

export function CreateResolveAirportsTool(context: ToolContext) {
  return betaZodTool({
    name: 'resolve_airports',
    description:
      'Resolve free text, a region name, a state, or a proximity search into concrete airports. ' +
      'Call this FIRST for any question that names places rather than airport codes. ' +
      'Returns candidates with confidence and an isAmbiguous flag - when ambiguous, ask the user which they meant rather than guessing. ' +
      'Call with no arguments to list the available named regions.',
    inputSchema: InputSchema,
    run: async (input) => {
      const repository = context.container.airportRepository;
      const limit = input.limit ?? DefaultLimit;

      // No arguments: describe what regions exist rather than returning nothing.
      if (!input.query && !input.regionId && !input.state && !input.nearIata) {
        const regions = Object.values(repository.GetRegions()).map((region) => ({
          id: region.id,
          label: region.label,
          states: region.states,
        }));
        return JSON.stringify(
          context.Wrap({ regions, note: 'Pass one of these regionId values, or a query/state/nearIata.' }, {
            sources: ['curated'],
          }),
        );
      }

      const { candidates, metroLabel } = Resolve(context, input, limit);
      // A colloquial metro name is ambiguous by definition, however confident
      // the individual matches look: "LA" means five different airports.
      const isAmbiguous = metroLabel !== null ? candidates.length > 1 : DetectAmbiguity(candidates);

      const caveats: string[] = [];
      if (metroLabel && candidates.length > 1) {
        caveats.push(
          `"${input.query}" was matched to the ${metroLabel}, which covers ${candidates.length} airports. ` +
            `Ask which one the user means, or confirm they want all of them compared.`,
        );
      } else if (isAmbiguous) {
        caveats.push(
          'Several airports match this equally well. Ask the user which they meant before running an analysis.',
        );
      }
      if (input.requiresCongestionData) {
        caveats.push(
          'Filtered to airports covered by BTS On-Time Performance; airports outside it have no congestion data.',
        );
      }

      return JSON.stringify(
        context.Wrap(
          {
            query: input.query ?? input.regionId ?? input.state ?? input.nearIata ?? '',
            isAmbiguous,
            matchCount: candidates.length,
            candidates: candidates.map((candidate) => ({
              iata: candidate.airport.iata,
              name: candidate.airport.name,
              city: candidate.airport.municipality,
              state: candidate.airport.state,
              hubClass: candidate.airport.hubClass,
              annualPassengers: candidate.airport.annualEnplanements,
              hasCongestionData: candidate.airport.reportsOnTimePerformance,
              confidence: Number(candidate.confidence.toFixed(2)),
              matchedOn: candidate.matchedOn,
            })),
          },
          { sources: ['our_airports', 't100_socrata'], caveats },
        ),
      );
    },
  });
}

function Resolve(context: ToolContext, input: z.infer<typeof InputSchema>, limit: number) {
  const repository = context.container.airportRepository;
  let found: Airport[] = [];
  let matchedOn: AirportResolutionCandidate['matchedOn'] = 'name';
  /** Set when the query matched a colloquial metro name rather than one airport. */
  let metroLabel: string | null = null;

  if (input.nearIata) {
    const origin = repository.GetByCode(input.nearIata);
    if (origin) {
      found = repository.FindWithinRadius(origin.latitude, origin.longitude, input.radiusKm ?? DefaultRadiusKm);
      matchedOn = 'proximity';
    }
  } else if (input.regionId) {
    found = repository.Find({ regionId: input.regionId });
    matchedOn = 'region';
  } else if (input.state) {
    found = repository.Find({ states: [input.state.toUpperCase()] });
    matchedOn = 'state';
  } else if (input.query) {
    // Curated metro names are checked FIRST, ahead of the code lookup.
    //
    // Two reasons. "LA" is a metro, not a substring - a text search returns
    // AtLanta and DalLas before Los Angeles. And IATA metropolitan codes leak
    // into the alias table from OurAirports keywords: "NYC" is listed on
    // Caldwell Essex County, so a code lookup resolves New York City to a
    // general-aviation field in New Jersey. Curated data beats scraped keywords.
    const region = repository.FindRegionByAlias(input.query);

    if (region) {
      found = repository.Find({ regionId: region.id });
      matchedOn = 'region';
      if (region.airportCodes.length > 0) metroLabel = region.label;
    } else {
      const exact = repository.GetByCode(input.query.trim());
      if (exact) {
        found = [exact];
        matchedOn = 'iata';
      } else {
        found = repository.SearchByText(input.query, limit * 2);
        matchedOn = 'name';
      }
    }
  }

  if (input.requiresCongestionData) found = found.filter((airport) => airport.reportsOnTimePerformance);

  const candidates = found
    .slice(0, limit)
    .map((airport) => ({ airport, confidence: ScoreConfidence(airport, matchedOn, found), matchedOn }));

  return { candidates, metroLabel };
}

/**
 * Confidence blends how the match was made with how prominent the airport is.
 * A three-letter code match is certain; a name match across several similar
 * airports is not, and traffic volume is the tiebreaker a human would use.
 */
function ScoreConfidence(airport: Airport, matchedOn: AirportResolutionCandidate['matchedOn'], all: Airport[]) {
  if (matchedOn === 'iata') return 1;

  const largest = all.reduce((maximum, candidate) => Math.max(maximum, candidate.annualEnplanements), 0);
  const share = largest > 0 ? airport.annualEnplanements / largest : 0;

  const base = matchedOn === 'name' ? 0.6 : 0.5;
  return Math.min(0.95, base + share * 0.35);
}

/** Ambiguous when the top candidates are too close to separate. */
function DetectAmbiguity(candidates: { confidence: number }[]) {
  if (candidates.length < 2) return false;
  const sorted = [...candidates].sort((left, right) => right.confidence - left.confidence);
  return sorted[0].confidence - sorted[1].confidence < AmbiguityGap;
}
