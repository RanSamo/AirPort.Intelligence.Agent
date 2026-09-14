/**
 * Opening questions offered in the interface.
 *
 * Computed suggestions are built from real findings in the snapshot, so the
 * interface demonstrates that the system already knows its own data before
 * the user has asked anything. They are deterministic: the same snapshot
 * always produces the same suggestions, because a figure that changed on
 * every refresh would undermine the reproducibility the whole system rests on.
 */
export interface Suggestion {
  id: string;
  question: string;
  /** 'computed' is derived from the data; 'generic' is a fixed starting point. */
  kind: 'computed' | 'generic';
  /** Shown under the question: the finding that motivated it. */
  rationale?: string;
}

export interface SuggestionSet {
  suggestions: Suggestion[];
  /** Snapshot the computed suggestions were derived from. */
  basedOn: string;
}
