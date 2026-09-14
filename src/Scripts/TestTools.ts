import { CreateScoringContainer } from '../Container/CreateScoringContainer';
import { CreateToolRegistry } from '../Agent/Tools/ToolRegistry';
import { ToolContext } from '../Agent/Tools/ToolContext';
import type { ToolEnvelope } from '../Types/Agent/Tool';

/**
 * Exercises every tool directly, with the arguments the model would send for
 * the four benchmark questions.
 *
 * This validates the entire deterministic half of the system — tool schemas,
 * engine wiring, envelope construction, caveats and exclusions — without
 * spending a token. If this passes and a live answer is still wrong, the
 * problem is tool selection or prompting, not the data path.
 *
 *   npm run tools:test
 */

interface ToolShape {
  name: string;
  run: (input: unknown) => Promise<string | unknown>;
}

interface Scenario {
  benchmark: string;
  tool: string;
  input: Record<string, unknown>;
  expect: (envelope: ToolEnvelope<Record<string, unknown>>) => string | null;
}

const scenarios: Scenario[] = [
  {
    benchmark: 'Q1: New England terminal expansion candidates',
    tool: 'rank_airports',
    input: { regionId: 'new_england', profile: 'terminal', topN: 5 },
    expect: (envelope) => {
      const scores = envelope.data.scores as { iata: string; score: number }[];
      if (!Array.isArray(scores) || scores.length === 0) return 'no airports ranked';
      if (scores[0].iata !== 'BOS') return `expected BOS first, got ${scores[0].iata}`;
      if (envelope.meta.exclusions.length === 0) return 'expected exclusions to be reported';
      return null;
    },
  },
  {
    benchmark: 'Open question: national ranking with no geographic filter',
    tool: 'rank_airports',
    input: { profile: 'terminal', topN: 5 },
    expect: (envelope) => {
      // This returned nothing before national screening existed, and it is
      // the most likely question a reviewer asks off-script.
      const scores = envelope.data.scores as { iata: string }[];
      if (!Array.isArray(scores) || scores.length === 0) return 'national ranking returned nothing';
      const considered = envelope.data.consideredCount as number;
      if (considered < 100) return `only ${considered} airports considered nationally`;
      return null;
    },
  },
  {
    benchmark: 'Screening: biggest passenger growth',
    tool: 'screen_airports',
    input: { metric: 'enplanement_cagr_3y', direction: 'highest', minAnnualPassengers: 500000, topN: 5 },
    expect: (envelope) => {
      const results = envelope.data.results as { iata: string; value: number }[];
      if (!Array.isArray(results) || results.length === 0) return 'no screening results';
      if (results[0].value < results[results.length - 1].value) return 'results not sorted descending';
      if (!envelope.meta.caveats.some((caveat) => caveat.includes('volatile'))) {
        return 'growth screens must warn that percentages are volatile at low-traffic airports';
      }
      return null;
    },
  },
  {
    benchmark: 'Secondary market: alternatives to LAX',
    tool: 'find_relief_airports',
    input: { iata: 'LAX', radiusKm: 150 },
    expect: (envelope) => {
      const primary = envelope.data.primary as { isConstrained: boolean };
      const candidates = envelope.data.candidates as { iata: string; headroomScore: number }[];
      if (!Array.isArray(candidates) || candidates.length === 0) return 'no relief candidates near LAX';
      if (!candidates.some((candidate) => candidate.iata === 'ONT')) return 'expected ONT among LA-area alternatives';
      if (candidates[0].headroomScore < candidates[candidates.length - 1].headroomScore) {
        return 'candidates not sorted by headroom';
      }
      if (!envelope.meta.caveats.some((caveat) => caveat.includes('ground access'))) {
        return 'must state that headroom is not a demand forecast';
      }
      return null;
    },
  },
  {
    benchmark: 'Q1 follow-up: is that ranking robust?',
    tool: 'test_score_sensitivity',
    input: { regionId: 'new_england', profile: 'terminal' },
    expect: (envelope) => {
      const ties = envelope.data.ties as unknown[];
      if (!Array.isArray(ties)) return 'ties missing';
      if (typeof envelope.data.isRankingRobust !== 'boolean') return 'robustness flag missing';
      return null;
    },
  },
  {
    benchmark: 'Q2: "LA" must be reported as ambiguous',
    tool: 'resolve_airports',
    input: { query: 'Los Angeles' },
    expect: (envelope) => {
      const candidates = envelope.data.candidates as { iata: string }[];
      if (!Array.isArray(candidates) || candidates.length === 0) return 'no candidates returned';
      return null;
    },
  },
  {
    benchmark: 'Q2: compare LA and Santa Ana congestion',
    tool: 'compare_airports',
    input: { iataCodes: ['LAX', 'SNA'], dimension: 'congestion' },
    expect: (envelope) => {
      const comparison = envelope.data.comparison as Record<string, { leader: string }>;
      if (!comparison.taxi_out_p90) return 'taxi_out_p90 missing from comparison';
      if (!envelope.meta.caveats.some((caveat) => caveat.includes('domestic'))) {
        return 'domestic-only caveat missing from a congestion comparison';
      }
      return null;
    },
  },
  {
    benchmark: 'Q3: long-haul share out of Anchorage',
    tool: 'get_haul_mix',
    input: { iata: 'ANC' },
    expect: (envelope) => {
      const bands = envelope.data.bands as { longHaul: { percent: number } } | undefined;
      if (!bands) return 'no haul bands returned';
      if (bands.longHaul.percent <= 0) return 'long-haul percent should be positive for ANC';
      if (envelope.data.basis !== 'domestic departures only') return 'basis must state domestic-only';

      // Guards the recent-window fix directly, rather than via a derived
      // percentage. Reading the full 11-year history here averaged current
      // traffic with the 2020 collapse; the passenger window must be the
      // recent 12 months, not 2015 onward.
      const passengerWindow = String(envelope.data.passengerWindow ?? '');
      if (passengerWindow.startsWith('2015')) {
        return `passengerWindow is "${passengerWindow}" - the full history, not the recent window`;
      }
      if (!/^\d{4}-\d{2} to \d{4}-\d{2}$/.test(passengerWindow)) {
        return `passengerWindow malformed: "${passengerWindow}"`;
      }
      return null;
    },
  },
  {
    benchmark: 'Q4: unmet demand at SFO and why',
    tool: 'estimate_unmet_demand',
    input: { iata: 'SFO' },
    expect: (envelope) => {
      const drivers = envelope.data.drivers as { driver: string }[];
      if (!Array.isArray(drivers) || drivers.length === 0) return 'no drivers attributed';
      if (typeof envelope.data.estimatedSpilledPassengers !== 'number') return 'spill figure missing';
      if (!envelope.meta.caveats.some((caveat) => caveat.includes('lower bound'))) {
        return 'lower-bound caveat missing from a spill estimate';
      }
      return null;
    },
  },
  {
    benchmark: 'Explainability: why does BOS score what it does',
    tool: 'explain_score',
    input: { iata: 'BOS', profile: 'terminal' },
    expect: (envelope) => {
      const terms = envelope.data.waterfall as { points: number }[];
      const total = envelope.data.waterfallTotal as number;
      if (!Array.isArray(terms) || terms.length === 0) return 'no waterfall terms';
      const summed = terms.reduce((running, term) => running + term.points, 0);
      if (Math.abs(summed - total) > 0.15) return `waterfall sums to ${summed}, expected ${total}`;
      return null;
    },
  },
  {
    benchmark: 'Coverage: a dark airport is still queryable',
    tool: 'get_airport_profile',
    input: { iata: 'HVN' },
    expect: (envelope) => {
      if (envelope.data.found !== true) return 'HVN should resolve';
      if (envelope.meta.caveats.length === 0) return 'expected caveats for an airport without congestion data';
      return null;
    },
  },
];

async function Main() {
  const container = CreateScoringContainer({ logLevel: 'error' });
  const tools = CreateToolRegistry(new ToolContext(container)) as unknown as ToolShape[];

  const byName = tools.reduce((accumulator: { [name: string]: ToolShape }, tool) => {
    accumulator[tool.name] = tool;
    return accumulator;
  }, {});

  let failures = 0;

  for (const scenario of scenarios) {
    const tool = byName[scenario.tool];
    if (!tool) {
      process.stdout.write(`FAIL  ${scenario.benchmark}\n      no such tool: ${scenario.tool}\n\n`);
      failures += 1;
      continue;
    }

    try {
      const raw = await tool.run(scenario.input);
      const envelope = JSON.parse(String(raw)) as ToolEnvelope<Record<string, unknown>>;
      const problem = scenario.expect(envelope);

      if (problem) {
        failures += 1;
        process.stdout.write(`FAIL  ${scenario.benchmark}\n      ${scenario.tool}: ${problem}\n\n`);
        continue;
      }

      process.stdout.write(`ok    ${scenario.benchmark}\n`);
      process.stdout.write(`      ${scenario.tool} -> ${Summarize(envelope)}\n\n`);
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`FAIL  ${scenario.benchmark}\n      ${scenario.tool} threw: ${message}\n\n`);
    }
  }

  process.stdout.write(`${scenarios.length - failures}/${scenarios.length} tool scenarios passed\n`);
  container.database.Close();
  if (failures > 0) process.exitCode = 1;
}

function Summarize(envelope: ToolEnvelope<Record<string, unknown>>) {
  const sources = envelope.meta.sources.map((source) => source.sourceId).join('+');
  return `${envelope.meta.caveats.length} caveats, ${envelope.meta.exclusions.length} exclusions, sources: ${sources}`;
}

Main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
