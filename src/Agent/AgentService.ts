import Anthropic from '@anthropic-ai/sdk';

import { BuildSystemPrompt } from './Prompt/SystemPrompt';
import { CreateToolRegistry } from './Tools/ToolRegistry';
import { SessionStore } from './Session/SessionStore';
import { ToolContext } from './Tools/ToolContext';
import type { ChatStreamEvent } from '../Types/Agent/Session';
import type { ScoringContainer } from '../Container/CreateScoringContainer';

/**
 * Drives the conversation.
 *
 * The model chooses tools and writes prose; every number it reports comes
 * from a tool result produced by the deterministic engine. The loop itself is
 * the SDK's tool runner rather than a hand-written while-loop.
 */

const Model = 'claude-opus-5';
const MaxTokens = 16_000;

export interface AgentOptions {
  /** Raised for ranking questions, which reward more deliberation. */
  effort?: 'low' | 'medium' | 'high';
}

export class AgentService {
  private readonly client: Anthropic;
  private readonly container: ScoringContainer;
  private readonly toolContext: ToolContext;
  private readonly systemPrompt: string;
  private readonly session: SessionStore;

  constructor(container: ScoringContainer, apiKey: string) {
    this.client = new Anthropic({ apiKey });
    this.container = container;
    this.toolContext = new ToolContext(container);
    this.systemPrompt = BuildSystemPrompt(this.toolContext);
    this.session = new SessionStore();
  }

  public Session() {
    return this.session;
  }

  /**
   * Answers one turn, streaming events as they happen.
   *
   * Events are emitted for tool calls as well as text so the UI can show what
   * the agent actually did. That transparency is the point: a reviewer should
   * be able to watch deterministic tools produce the numbers being narrated.
   */
  public async *Ask(question: string, options: AgentOptions = {}): AsyncGenerator<ChatStreamEvent> {
    const tools = CreateToolRegistry(this.toolContext);

    this.session.Append({ role: 'user', content: question });

    // Entity context rides in a mid-conversation system message so the cached
    // prefix (tools + system prompt) stays byte-identical across turns.
    const contextMessage = this.session.BuildContextMessage();
    if (contextMessage) {
      this.session.Append({ role: 'system', content: contextMessage } as never);
    }

    // stream: true makes each iteration yield a token stream rather than a
    // finished message. Without it the answer lands in two or three large
    // chunks and the user watches a spinner for twenty seconds.
    const runner = this.client.beta.messages.toolRunner({
      model: Model,
      max_tokens: MaxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort: options.effort ?? 'medium' },
      system: [
        {
          type: 'text',
          text: this.systemPrompt,
          // Everything before this point is stable, so it caches across turns.
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools,
      messages: this.session.Messages(),
      stream: true,
    });

    try {
      for await (const stream of runner) {
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            yield { type: 'text', text: event.delta.text };
          }
        }

        const message = await stream.finalMessage();

        // Tool calls are emitted once the message completes: the arguments
        // arrive as a partial JSON stream and are only valid at the end.
        for (const block of message.content) {
          if (block.type !== 'tool_use') continue;
          this.session.RememberFromToolInput(block.name, block.input);
          yield { type: 'tool_start', toolName: block.name, toolInput: block.input };
        }

        // Server-tool turns can pause; the runner does not auto-resume them.
        if (message.stop_reason === 'pause_turn') {
          runner.pushMessages({ role: 'assistant', content: message.content });
        }
      }

      const final = await runner.done();
      if (final) this.session.Append({ role: 'assistant', content: final.content });

      yield { type: 'done' };
    } catch (error) {
      yield { type: 'error', message: this.DescribeError(error) };
    }
  }

  /** Collects a full answer. Convenience for evals and non-streaming callers. */
  public async AskOnce(question: string, options: AgentOptions = {}) {
    const parts: string[] = [];
    const toolsUsed: string[] = [];

    for await (const event of this.Ask(question, options)) {
      if (event.type === 'text' && event.text) parts.push(event.text);
      if (event.type === 'tool_start' && event.toolName) toolsUsed.push(event.toolName);
      if (event.type === 'error') throw new Error(event.message ?? 'Agent error');
    }

    return { answer: parts.join(''), toolsUsed };
  }

  private DescribeError(error: unknown) {
    if (error instanceof Anthropic.AuthenticationError) {
      return 'Authentication failed. Check ANTHROPIC_API_KEY in .env.';
    }
    if (error instanceof Anthropic.RateLimitError) {
      return 'Rate limited by the Anthropic API. Wait a moment and try again.';
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return 'Could not reach the Anthropic API. Check your network connection.';
    }
    if (error instanceof Anthropic.APIError) {
      return `Anthropic API error (${error.status}): ${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
  }
}
