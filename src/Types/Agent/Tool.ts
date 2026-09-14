import type { ExclusionReason } from '../Data/Coverage';
import type { SourceCitation } from '../Data/Source';

/**
 * Tool wire names.
 *
 * snake_case deliberately: these are values sent to the model as part of the
 * tool schema, not TypeScript identifiers. The implementing functions and
 * files follow the project's PascalCase convention.
 */
export type ToolName =
  | 'resolve_airports'
  | 'get_airport_profile'
  | 'rank_airports'
  | 'screen_airports'
  | 'compare_airports'
  | 'find_relief_airports'
  | 'explain_score'
  | 'estimate_unmet_demand'
  | 'get_haul_mix'
  | 'test_score_sensitivity'
  | 'get_live_status';

/**
 * Metadata carried by every tool result.
 *
 * This is how "communicate assumptions, uncertainty and scoping" becomes a
 * structural guarantee instead of a hope: uncertainty travels attached to the
 * data, and the system prompt requires the agent to surface non-empty
 * caveats and exclusions.
 */
export interface ToolMeta {
  sources: SourceCitation[];
  /** Data vintage this answer reflects, e.g. "BTS OTP through 2026-06". */
  asOf: string;
  /** 0-1 metric coverage behind this result. */
  coverage: number;
  exclusions: ExclusionReason[];
  caveats: string[];
  cached: boolean;
}

/**
 * Uniform envelope returned by every tool.
 *
 * Plain interfaces rather than Map so the payload serializes natively to the
 * JSON the model receives.
 */
export interface ToolEnvelope<TData> {
  data: TData;
  meta: ToolMeta;
}
