import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Suggestion } from '../Types';

/**
 * Opening questions.
 *
 * The computed ones are built from real findings in the snapshot, so the
 * interface shows it already knows its data before anything is asked. The
 * figures are deterministic — only which four you see is shuffled, and a
 * reshuffle control makes that visible rather than hidden.
 */

const VisibleCount = 4;

export function Suggestions({ onPick }: { onPick: (question: string) => void }) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [seed, setSeed] = useState(0);

  useEffect(() => {
    fetch('/api/suggestions')
      .then((response) => response.json())
      .then((payload: { suggestions: Suggestion[] }) => setSuggestions(payload.suggestions ?? []))
      .catch(() => setSuggestions([]));
  }, []);

  // Always keep at least one computed suggestion visible: a panel of purely
  // generic prompts loses the point of building them from the data.
  const visible = useMemo(() => {
    if (suggestions.length === 0) return [];

    const computed = suggestions.filter((entry) => entry.kind === 'computed');
    const generic = suggestions.filter((entry) => entry.kind === 'generic');

    const shuffledComputed = Shuffle(computed, seed);
    const shuffledGeneric = Shuffle(generic, seed + 1);

    return [...shuffledComputed, ...shuffledGeneric].slice(0, VisibleCount);
  }, [suggestions, seed]);

  const Reshuffle = useCallback(() => setSeed((previous) => previous + 2), []);

  if (visible.length === 0) return null;

  return (
    <div className="suggestions">
      <div className="suggestions-head">
        <span>Suggested starting points</span>
        <button type="button" className="link-button" onClick={Reshuffle}>
          Shuffle
        </button>
      </div>

      {visible.map((suggestion) => (
        <button
          key={suggestion.id}
          type="button"
          className="suggestion"
          onClick={() => onPick(suggestion.question)}
        >
          <span className="suggestion-question">{suggestion.question}</span>
          {suggestion.rationale ? <span className="suggestion-why">{suggestion.rationale}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Deterministic shuffle, so a given seed always produces the same order. */
function Shuffle<TItem>(items: TItem[], seed: number) {
  const result = [...items];
  let state = seed * 9301 + 49297;

  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 9301 + 49297) % 233280;
    const swapWith = Math.floor((state / 233280) * (index + 1));
    const temporary = result[index];
    result[index] = result[swapWith];
    result[swapWith] = temporary;
  }
  return result;
}
