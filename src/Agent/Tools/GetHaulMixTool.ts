import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';

import { Caveats } from './ToolContext';
import { HaulDistanceBands } from '../../Config/DataSources';
import type { ToolContext } from './ToolContext';

/**
 * Distance mix of departures.
 *
 * Answers "what percentage of flights out of X are long haul". The
 * domestic-only caveat is mandatory here rather than optional: BTS On-Time
 * Performance excludes international segments entirely, so at an airport with
 * meaningful international service an unqualified percentage is misleading.
 * Anchorage happens to be 0.2% international, so for that airport the
 * domestic figure is very nearly the whole picture - but that is a property
 * of Anchorage, not a general licence to drop the caveat.
 */

const InputSchema = z.object({
  iata: z.string().describe('Airport code.'),
});

export function CreateGetHaulMixTool(context: ToolContext) {
  return betaZodTool({
    name: 'get_haul_mix',
    description:
      'Breakdown of departures by flight distance (short / medium / long haul) for one airport, plus its ' +
      'international passenger share. DOMESTIC FLIGHTS ONLY - always state this when reporting the figures.',
    inputSchema: InputSchema,
    run: async (input) => {
      const airport = context.container.airportRepository.GetByCode(input.iata);
      if (!airport) {
        return JSON.stringify(
          context.Wrap({ found: false, note: `No US airport matches "${input.iata}".` }, { sources: ['our_airports'] }),
        );
      }

      const months = context.container.congestionRepository.GetHaulMix(
        airport.iata,
        context.congestionRange.from,
        context.congestionRange.to,
      );

      if (months.length === 0) {
        return JSON.stringify(
          context.Wrap(
            {
              found: true,
              hasData: false,
              note:
                `${airport.name} is not covered by BTS On-Time Performance reporting, which only includes carriers ` +
                `above 0.5% of US domestic revenue, so no flight-distance breakdown exists for it.`,
            },
            { sources: ['bts_otp'], coverage: 0 },
          ),
        );
      }

      const totals = months.reduce(
        (accumulator: HaulTotals, month) => {
          accumulator.short += month.shortHaulFlights;
          accumulator.medium += month.mediumHaulFlights;
          accumulator.long += month.longHaulFlights;
          accumulator.total += month.totalFlights;
          return accumulator;
        },
        { short: 0, medium: 0, long: 0, total: 0 },
      );

      // Recent window, not the full history: averaging today's international
      // share across 11 years including 2020 misstates the current picture.
      const traffic = context.container.trafficRepository.GetMonths(
        airport.iata,
        context.recentTrafficRange.from,
        context.recentTrafficRange.to,
      );
      const passengerTotals = traffic.reduce(
        (accumulator: { passengers: number; international: number }, month) => {
          accumulator.passengers += month.passengers;
          accumulator.international += month.internationalPassengers;
          return accumulator;
        },
        { passengers: 0, international: 0 },
      );

      const internationalShare =
        passengerTotals.passengers > 0 ? passengerTotals.international / passengerTotals.passengers : 0;

      const caveats = [Caveats.domesticOnly];
      if (internationalShare > 0.1) {
        caveats.push(
          `${airport.name} is ${(internationalShare * 100).toFixed(1)}% international by passengers, so these ` +
            `domestic-only percentages describe a minority-to-substantial share of its actual departures. ` +
            `Say so explicitly rather than presenting them as the airport total.`,
        );
      }

      const percent = (value: number) => (totals.total > 0 ? Number(((value / totals.total) * 100).toFixed(1)) : 0);

      return JSON.stringify(
        context.Wrap(
          {
            iata: airport.iata,
            name: airport.name,
            flightWindow: `${context.congestionRange.from} to ${context.congestionRange.to}`,
            // Stated separately because the two sources have different
            // vintages, and because the international share is strongly
            // seasonal at some airports - Anchorage is 1.4% across the year
            // but only 0.2% in April.
            passengerWindow: context.RecentWindowLabel(),
            basis: 'domestic departures only',
            bands: {
              shortHaul: { maxMiles: HaulDistanceBands.shortHaulMaxMiles, flights: totals.short, percent: percent(totals.short) },
              mediumHaul: {
                maxMiles: HaulDistanceBands.mediumHaulMaxMiles,
                flights: totals.medium,
                percent: percent(totals.medium),
              },
              longHaul: {
                minMiles: HaulDistanceBands.mediumHaulMaxMiles + 1,
                flights: totals.long,
                percent: percent(totals.long),
              },
            },
            totalDomesticFlights: totals.total,
            internationalPassengerSharePercent: Number((internationalShare * 100).toFixed(1)),
          },
          { sources: ['bts_otp', 't100_socrata'], caveats },
        ),
      );
    },
  });
}

interface HaulTotals {
  short: number;
  medium: number;
  long: number;
  total: number;
}
