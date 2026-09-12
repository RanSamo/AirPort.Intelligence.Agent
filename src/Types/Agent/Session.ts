import type { IataCode } from '../Domain/Airport';
import type { AggregationMode, ScoreProfileId } from '../Scoring/ScoringConfig';

/**
 * Conversational state for follow-up questions.
 *
 * Tracks what "it", "the second one" and "those airports" refer to, so that
 * follow-ups resolve without re-asking. Injected as a mid-conversation system
 * message appended to messages[] rather than by editing the top-level system
 * prompt — on Opus 5 that preserves the cached prefix, whereas editing the
 * top-level system field would invalidate it on every turn.
 */
export interface SessionContext {
  lastAirports: IataCode[];
  lastProfile: ScoreProfileId | null;
  lastAggregation: AggregationMode | null;
  lastPeriodId: string | null;
  lastRegionId: string | null;
}

export type ChatEventType = 'text' | 'tool_start' | 'tool_result' | 'error' | 'done';

/** Server-sent event streamed to the chat UI. Powers the live agent-trace panel. */
export interface ChatStreamEvent {
  type: ChatEventType;
  /** Present for 'text'. */
  text?: string;
  /** Present for 'tool_start' and 'tool_result'. */
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  /** Present for 'error'. */
  message?: string;
}

export interface SessionRecord {
  sessionId: string;
  createdAt: string;
  context: SessionContext;
}

export interface SessionsById {
  [sessionId: string]: SessionRecord;
}
