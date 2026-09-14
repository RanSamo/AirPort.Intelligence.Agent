import type Anthropic from '@anthropic-ai/sdk';
import type { SessionContext } from '../../Types/Agent/Session';

/**
 * Conversation state for follow-up questions.
 *
 * Two things are tracked: the append-only message history, and a small record
 * of what was last discussed so that "compare it to the other one" resolves
 * without asking the user to repeat themselves.
 *
 * The entity context is injected as a mid-conversation system message rather
 * than by editing the top-level system prompt. On Opus 5 that preserves the
 * cached prefix; editing the system field would invalidate the cache on every
 * single turn.
 */
export class SessionStore {
  private readonly messages: Anthropic.Beta.BetaMessageParam[] = [];
  private context: SessionContext = {
    lastAirports: [],
    lastProfile: null,
    lastAggregation: null,
    lastPeriodId: null,
    lastRegionId: null,
  };

  public Messages() {
    return this.messages;
  }

  public Append(message: Anthropic.Beta.BetaMessageParam) {
    this.messages.push(message);
  }

  public Context() {
    return this.context;
  }

  public Remember(update: Partial<SessionContext>) {
    this.context = { ...this.context, ...update };
  }

  /**
   * Records which entities a tool call touched, so follow-ups can refer to
   * them. Reads the arguments the model sent rather than the results, because
   * that is what the user's phrasing actually referred to.
   */
  public RememberFromToolInput(toolName: string, input: unknown) {
    if (!input || typeof input !== 'object') return;
    const fields = input as ToolInputShape;

    if (Array.isArray(fields.iataCodes) && fields.iataCodes.length > 0) {
      this.Remember({ lastAirports: fields.iataCodes.map((code) => String(code).toUpperCase()) });
    }
    if (typeof fields.iata === 'string') {
      this.Remember({ lastAirports: [fields.iata.toUpperCase()] });
    }
    if (typeof fields.regionId === 'string') this.Remember({ lastRegionId: fields.regionId });
    if (typeof fields.profile === 'string') this.Remember({ lastProfile: fields.profile as never });
    if (typeof fields.aggregation === 'string') this.Remember({ lastAggregation: fields.aggregation as never });
  }

  /** Null when there is nothing worth telling the model about yet. */
  public BuildContextMessage() {
    const parts: string[] = [];
    if (this.context.lastAirports.length > 0) {
      parts.push(`airports last discussed: ${this.context.lastAirports.join(', ')}`);
    }
    if (this.context.lastRegionId) parts.push(`region last discussed: ${this.context.lastRegionId}`);
    if (this.context.lastProfile) parts.push(`score profile in use: ${this.context.lastProfile}`);
    if (this.context.lastAggregation) parts.push(`aggregation in use: ${this.context.lastAggregation}`);

    if (parts.length === 0) return null;
    return `Conversation context — ${parts.join('; ')}. Resolve pronouns and references against these unless the user names something else.`;
  }

  public Reset() {
    this.messages.length = 0;
    this.context = {
      lastAirports: [],
      lastProfile: null,
      lastAggregation: null,
      lastPeriodId: null,
      lastRegionId: null,
    };
  }
}

interface ToolInputShape {
  iata?: unknown;
  iataCodes?: unknown[];
  regionId?: unknown;
  profile?: unknown;
  aggregation?: unknown;
}
