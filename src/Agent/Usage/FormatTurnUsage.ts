import type { TurnUsage } from '../../Types/Agent/Session';

/**
 * One-line usage summary shared by the CLI and the server log, so both report
 * prompt-cache behaviour in exactly the same terms.
 */
export function FormatTurnUsage(usage: TurnUsage) {
  const format = (value: number) => value.toLocaleString('en-US');
  const calls = `${usage.apiCalls} API call${usage.apiCalls === 1 ? '' : 's'}`;

  return [
    calls,
    `input ${format(usage.inputTokens)}`,
    `cache read ${format(usage.cacheReadTokens)}`,
    `cache write ${format(usage.cacheWriteTokens)}`,
    `output ${format(usage.outputTokens)}`,
  ].join(' · ');
}
