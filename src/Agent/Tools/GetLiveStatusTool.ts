import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';

import { FaaNasStatusEndpoint } from '../../Config/DataSources';
import type { ToolContext } from './ToolContext';

/**
 * Live FAA operational status.
 *
 * The snapshot lags by roughly three months, which is fine for a multi-year
 * capital decision but useless for "what is happening right now". This closes
 * that gap, and is the one tool that calls a public API at request time.
 *
 * It NEVER feeds a score. Today's ground stop says nothing about whether an
 * airport merits a terminal investment, and letting live noise leak into a
 * structural ranking would make the ranking irreproducible.
 */

const InputSchema = z.object({
  iata: z.string().optional().describe('Airport code to check. Omit to get every airport currently affected.'),
});

/** FAA publishes XML; the feed is small and flat enough not to warrant a parser dependency. */
const EntryPattern = /<(Ground_Delay|Ground_Stop|Arrival_Departure_Delay|Airport_Closure)>([\s\S]*?)<\/\1>/g;

export function CreateGetLiveStatusTool(context: ToolContext) {
  return betaZodTool({
    name: 'get_live_status',
    description:
      'Current FAA ground stops, ground delay programmes and airport closures, fetched live. ' +
      'Use ONLY for questions about conditions right now. This is operational weather-and-traffic noise: ' +
      'it never affects investment scores and must not be presented as evidence about expansion potential.',
    inputSchema: InputSchema,
    run: async (input) => {
      try {
        const xml = await context.container.liveFetcher.FetchText(FaaNasStatusEndpoint.url, {
          ttlSeconds: FaaNasStatusEndpoint.ttlSeconds,
          timeoutMs: 15_000,
        });

        const updatedAt = Extract(xml, 'Update_Time');
        const entries = ParseEntries(xml);
        const wanted = input.iata?.trim().toUpperCase();
        const filtered = wanted ? entries.filter((entry) => entry.airport === wanted) : entries;

        return JSON.stringify(
          context.Wrap(
            {
              source: 'FAA National Airspace System Status',
              updatedAt,
              queriedAirport: wanted ?? 'all',
              affectedAirportCount: filtered.length,
              events: filtered,
              note:
                filtered.length === 0
                  ? wanted
                    ? `${wanted} currently has no FAA delay programme in effect.`
                    : 'No airports currently have an FAA delay programme in effect.'
                  : undefined,
            },
            {
              sources: ['faa_nas_status'],
              caveats: [
                'Live operational status only. This reflects today weather and traffic, not structural capacity, and is never used in scoring.',
              ],
            },
          ),
        );
      } catch (error) {
        // A live feed being down must degrade gracefully, not fail the turn.
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify(
          context.Wrap(
            { available: false, note: `The FAA live status feed could not be reached: ${message}` },
            { sources: ['faa_nas_status'], caveats: ['Live status is unavailable; all other analysis is unaffected.'] },
          ),
        );
      }
    },
  });
}

function ParseEntries(xml: string) {
  const entries: LiveEvent[] = [];
  let match = EntryPattern.exec(xml);

  while (match !== null) {
    const [, kind, body] = match;
    const airport = Extract(body, 'ARPT');
    if (airport) {
      entries.push({
        airport,
        kind: kind.replace(/_/g, ' ').toLowerCase(),
        reason: Extract(body, 'Reason') || undefined,
        averageDelay: Extract(body, 'Avg') || undefined,
        maximumDelay: Extract(body, 'Max') || undefined,
      });
    }
    match = EntryPattern.exec(xml);
  }

  EntryPattern.lastIndex = 0;
  return entries;
}

function Extract(xml: string, tag: string) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? match[1].trim() : '';
}

interface LiveEvent {
  airport: string;
  kind: string;
  reason?: string;
  averageDelay?: string;
  maximumDelay?: string;
}
