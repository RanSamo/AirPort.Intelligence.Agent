import 'dotenv/config';
import { createInterface } from 'node:readline/promises';

import { AgentService } from '../Agent/AgentService';
import { CreateScoringContainer } from '../Container/CreateScoringContainer';

/**
 * Conversational CLI.
 *
 * Deliberately shipped alongside the web UI: it needs no build step, so a
 * reviewer can clone the repo and talk to the agent immediately, and it stays
 * usable if anything in the front end breaks.
 *
 *   npm run chat
 *   npm run chat -- "What is the unmet demand at SFO and why?"
 */

const Divider = '-'.repeat(72);

function FormatToolCall(name: string, input: unknown) {
  const args = input && typeof input === 'object' ? Object.entries(input as Record<string, unknown>) : [];
  const rendered = args
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('/') : String(value)}`)
    .join(' ');
  return `  [tool] ${name}${rendered ? ` ${rendered}` : ''}`;
}

async function Ask(agent: AgentService, question: string) {
  let wroteText = false;

  for await (const event of agent.Ask(question)) {
    if (event.type === 'tool_start' && event.toolName) {
      process.stdout.write(`${FormatToolCall(event.toolName, event.toolInput)}\n`);
    }
    if (event.type === 'text' && event.text) {
      if (!wroteText) {
        process.stdout.write('\n');
        wroteText = true;
      }
      process.stdout.write(event.text);
    }
    if (event.type === 'error') {
      process.stderr.write(`\n  error: ${event.message}\n`);
    }
  }
  process.stdout.write('\n');
}

/** Collects every non-empty line from stdin. Used for scripted conversations. */
async function ReadAllInput() {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));

  return chunks
    .join('')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function Main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.\n');
    process.exit(1);
  }

  const container = CreateScoringContainer({ logLevel: 'error' });
  const agent = new AgentService(container, apiKey);

  const meta = container.trafficRepository.GetAvailableRange();
  const congestion = container.congestionRepository.GetAvailableRange();

  const oneShot = process.argv.slice(2).filter((token) => !token.startsWith('--')).join(' ');
  if (oneShot) {
    await Ask(agent, oneShot);
    container.database.Close();
    return;
  }

  // Piped input is read up front rather than through the interactive loop.
  // readline emits 'close' as soon as the stream ends, which both discards
  // buffered lines and makes the next question() reject - so a scripted
  // multi-turn conversation would lose every question after the first.
  if (!process.stdin.isTTY) {
    const piped = await ReadAllInput();
    for (const question of piped) {
      if (question === 'exit' || question === 'quit') break;
      process.stdout.write(`\n> ${question}\n`);
      await Ask(agent, question);
    }
    container.database.Close();
    return;
  }

  process.stdout.write(`${Divider}\n`);
  process.stdout.write('Airport Investment Intelligence Agent\n');
  process.stdout.write(`traffic through ${meta.to} | congestion through ${congestion.to}\n`);
  process.stdout.write('Ask a question, or type "exit" to quit.\n');
  process.stdout.write(`${Divider}\n`);

  const readline = createInterface({ input: process.stdin, output: process.stdout });

  for (;;) {
    const question = (await readline.question('\n> ')).trim();
    if (!question) continue;
    if (question === 'exit' || question === 'quit') break;

    await Ask(agent, question);
  }

  readline.close();
  container.database.Close();
}

Main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`\nChat failed:\n${message}\n`);
  process.exit(1);
});
