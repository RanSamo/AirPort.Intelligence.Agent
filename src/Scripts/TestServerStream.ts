/**
 * Verifies the SSE chat endpoint end to end.
 *
 * Streaming is easy to break in ways that only show up in a browser — a
 * buffering proxy header, a malformed frame, events arriving as one blob at
 * the end. This consumes the stream the same way the front end does and
 * reports what arrived and when.
 *
 *   npm run test:stream
 *   npm run test:stream -- "your question here"
 */

const Endpoint = process.env.API_URL ?? 'http://localhost:3001';
const DefaultQuestion = 'What is the percentage of long haul flights out of Anchorage airport?';

interface StreamEvent {
  type: string;
  text?: string;
  toolName?: string;
  message?: string;
}

async function Main() {
  const question = process.argv.slice(2).join(' ') || DefaultQuestion;
  const startedAt = Date.now();

  process.stdout.write(`POST ${Endpoint}/api/chat\n  "${question}"\n\n`);

  const response = await fetch(`${Endpoint}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'stream-test', question }),
  });

  if (!response.ok || !response.body) {
    process.stderr.write(`Server responded ${response.status}\n`);
    process.exit(1);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    process.stderr.write(`Expected text/event-stream, got "${contentType}"\n`);
    process.exit(1);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let textChunks = 0;
  let characters = 0;
  let firstTextAt = 0;
  const tools: string[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
      if (!line) continue;

      const event = JSON.parse(line.slice(6)) as StreamEvent;
      const elapsed = Date.now() - startedAt;

      if (event.type === 'tool_start' && event.toolName) {
        tools.push(event.toolName);
        process.stdout.write(`  ${String(elapsed).padStart(6)}ms  tool  ${event.toolName}\n`);
      }
      if (event.type === 'text' && event.text) {
        if (firstTextAt === 0) {
          firstTextAt = elapsed;
          process.stdout.write(`  ${String(elapsed).padStart(6)}ms  text  (first chunk)\n`);
        }
        textChunks += 1;
        characters += event.text.length;
      }
      if (event.type === 'error') {
        process.stderr.write(`  ${String(elapsed).padStart(6)}ms  ERROR ${event.message}\n`);
        process.exit(1);
      }
      if (event.type === 'done') {
        process.stdout.write(`  ${String(elapsed).padStart(6)}ms  done\n`);
      }
    }
  }

  process.stdout.write('\n--- summary ---\n');
  process.stdout.write(`  tools called    ${tools.length > 0 ? tools.join(', ') : '(none)'}\n`);
  process.stdout.write(`  text events     ${textChunks}\n`);
  process.stdout.write(`  characters      ${characters}\n`);
  process.stdout.write(`  first text at   ${firstTextAt}ms\n`);
  process.stdout.write(`  total           ${Date.now() - startedAt}ms\n`);

  if (characters === 0) {
    process.stderr.write('\nFAIL: no text was streamed\n');
    process.exit(1);
  }
  // Arriving as a single chunk means something buffered the whole response.
  process.stdout.write(
    textChunks > 1
      ? '\nok: response streamed incrementally\n'
      : '\nWARNING: the whole answer arrived in one event - check for a buffering proxy\n',
  );
}

Main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
