/** Mirrors src/Types/Agent/Session.ts on the server. */
export type ChatEventType = 'text' | 'tool_start' | 'tool_result' | 'error' | 'done';

export interface ChatStreamEvent {
  type: ChatEventType;
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  message?: string;
}

export interface ToolCall {
  name: string;
  input: unknown;
  at: number;
}

export interface ChatTurn {
  role: 'user' | 'agent';
  text: string;
  toolCalls: ToolCall[];
  isStreaming: boolean;
  error?: string;
}

export interface Suggestion {
  id: string;
  question: string;
  kind: 'computed' | 'generic';
  rationale?: string;
}

export interface MetricSummary {
  id: string;
  label: string;
  pillar: string;
  provenance: string;
  description: string;
}

export interface AgentMeta {
  data: {
    trafficThrough: string;
    congestionThrough: string;
    trafficFrom: string;
    congestionFrom: string;
    airportsWithTraffic: number;
    airportsWithCongestion: number;
  };
  scoring: {
    version: string;
    scoreVersion: string;
    aggregation: string;
    defaultProfile: string;
    materiality: string;
    spillKFactor: number;
    sensitivityDraws: number;
  };
  metrics: MetricSummary[];
  limitations: string[];
}
