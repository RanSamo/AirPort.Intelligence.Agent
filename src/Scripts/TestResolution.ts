import { CreateScoringContainer } from '../Container/CreateScoringContainer';
import { CreateToolRegistry } from '../Agent/Tools/ToolRegistry';
import { ToolContext } from '../Agent/Tools/ToolContext';
import type { ToolEnvelope } from '../Types/Agent/Tool';

/**
 * Entity-resolution checks.
 *
 * Resolution is where a wrong answer is hardest to notice: the agent sounds
 * just as confident describing Atlanta when the user asked about LA. These
 * cases are asserted rather than eyeballed.
 *
 *   npm run test:resolution
 */

interface ResolutionCase {
  query: string;
  expectAmbiguous: boolean;
  mustInclude?: string[];
  mustNotInclude?: string[];
  note: string;
}

const cases: ResolutionCase[] = [
  {
    query: 'LA',
    expectAmbiguous: true,
    mustInclude: ['LAX', 'BUR', 'SNA'],
    mustNotInclude: ['ATL', 'DFW', 'MCO'],
    note: 'colloquial metro name; a substring search returns AtLanta and DalLas instead',
  },
  {
    query: 'Los Angeles',
    expectAmbiguous: true,
    mustInclude: ['LAX'],
    mustNotInclude: ['ATL'],
    note: 'full metro name resolves to the same set',
  },
  {
    query: 'Santa Ana',
    expectAmbiguous: false,
    mustInclude: ['SNA'],
    note: 'city name for a single airport',
  },
  {
    query: 'NYC',
    expectAmbiguous: true,
    mustInclude: ['JFK', 'LGA', 'EWR'],
    note: 'metro covering three major airports',
  },
  {
    query: 'Bay Area',
    expectAmbiguous: true,
    mustInclude: ['SFO', 'OAK', 'SJC'],
    note: 'metro that crosses no state line but is not one airport',
  },
  {
    query: 'BOS',
    expectAmbiguous: false,
    mustInclude: ['BOS'],
    note: 'exact airport code is unambiguous',
  },
  {
    query: 'PBI',
    expectAmbiguous: false,
    mustInclude: ['DJT'],
    note: 'historic code resolves through the alias table',
  },
];

interface ToolShape {
  name: string;
  run: (input: unknown) => Promise<string | unknown>;
}

interface ResolutionData {
  isAmbiguous: boolean;
  candidates: { iata: string; name: string }[];
}

async function Main() {
  const container = CreateScoringContainer({ logLevel: 'error' });
  const tools = CreateToolRegistry(new ToolContext(container)) as unknown as ToolShape[];
  const resolve = tools.find((tool) => tool.name === 'resolve_airports');

  if (!resolve) {
    process.stderr.write('resolve_airports tool not registered\n');
    process.exit(1);
  }

  let failures = 0;

  for (const testCase of cases) {
    const envelope = JSON.parse(String(await resolve.run({ query: testCase.query }))) as ToolEnvelope<ResolutionData>;
    const codes = (envelope.data.candidates ?? []).map((candidate) => candidate.iata);
    const problems: string[] = [];

    if (envelope.data.isAmbiguous !== testCase.expectAmbiguous) {
      problems.push(`expected isAmbiguous=${testCase.expectAmbiguous}, got ${envelope.data.isAmbiguous}`);
    }
    for (const required of testCase.mustInclude ?? []) {
      if (!codes.includes(required)) problems.push(`missing ${required}`);
    }
    for (const forbidden of testCase.mustNotInclude ?? []) {
      if (codes.includes(forbidden)) problems.push(`should not match ${forbidden}`);
    }

    if (problems.length > 0) {
      failures += 1;
      process.stdout.write(`FAIL  "${testCase.query}"  (${testCase.note})\n`);
      process.stdout.write(`      ${problems.join('; ')}\n`);
      process.stdout.write(`      got: ${codes.slice(0, 6).join(', ')}\n\n`);
      continue;
    }

    process.stdout.write(`ok    "${testCase.query}" -> ${codes.slice(0, 5).join(', ')}`);
    process.stdout.write(envelope.data.isAmbiguous ? '  [ambiguous, agent must ask]\n' : '\n');
  }

  process.stdout.write(`\n${cases.length - failures}/${cases.length} resolution cases passed\n`);
  container.database.Close();
  if (failures > 0) process.exitCode = 1;
}

Main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
