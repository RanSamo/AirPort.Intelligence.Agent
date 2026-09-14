import type { ToolCall } from '../Types';

/**
 * Live view of the tools the agent called.
 *
 * This is the transparency argument made visible: every number in the answer
 * came from one of these deterministic calls, and a reviewer can watch them
 * happen rather than taking the prose on trust.
 */

const ToolDescriptions: Record<string, string> = {
  resolve_airports: 'Resolved place names to airports',
  get_airport_profile: 'Read a full airport profile',
  rank_airports: 'Ran the deterministic ranking engine',
  compare_airports: 'Compared airports metric by metric',
  explain_score: 'Decomposed a score into its terms',
  estimate_unmet_demand: 'Ran the airline spill model',
  get_haul_mix: 'Read the flight-distance breakdown',
  test_score_sensitivity: 'Resampled the weights to test robustness',
  get_live_status: 'Fetched live FAA operational status',
};

export function AgentTrace({ toolCalls, isStreaming }: { toolCalls: ToolCall[]; isStreaming: boolean }) {
  if (toolCalls.length === 0) {
    return isStreaming ? <div className="trace-empty">Thinking…</div> : null;
  }

  return (
    <div className="trace">
      {toolCalls.map((call, index) => (
        <div className="trace-row" key={`${call.name}-${call.at}-${index}`}>
          <span className="trace-index">{index + 1}</span>
          <div className="trace-body">
            <code className="trace-name">{call.name}</code>
            <div className="trace-note">{ToolDescriptions[call.name] ?? 'Tool call'}</div>
            <FormatArguments input={call.input} />
          </div>
        </div>
      ))}
      {isStreaming ? <div className="trace-empty">Working…</div> : null}
    </div>
  );
}

function FormatArguments({ input }: { input: unknown }) {
  if (!input || typeof input !== 'object') return null;

  const entries = Object.entries(input as Record<string, unknown>).filter(
    ([, value]) => value !== undefined && value !== null && value !== '',
  );
  if (entries.length === 0) return null;

  return (
    <div className="trace-args">
      {entries.map(([key, value]) => (
        <span className="trace-arg" key={key}>
          {key}=<strong>{Array.isArray(value) ? value.join(', ') : String(value)}</strong>
        </span>
      ))}
    </div>
  );
}
