import { describe, expect, it } from 'vitest';

import { SelectBestVoice } from '../../web/src/Services/VoiceSelection';
import type { SelectableVoice } from '../../web/src/Services/VoiceSelection';

/**
 * Voice selection.
 *
 * Left to itself, speechSynthesis picks a voice matching the operating system
 * locale - so on a machine configured for Hebrew it reads English through a
 * Hebrew voice, which sounds like a heavy accent mangling every word. Voice
 * choice is therefore explicit, and ranked by quality.
 */

function Voice(name: string, lang: string, localService = true, isDefault = false): SelectableVoice {
  return { name, lang, localService, default: isDefault };
}

function Select(voices: SelectableVoice[]) {
  return SelectBestVoice(voices);
}

describe('SelectBestVoice', () => {
  it('never returns a non-English voice', () => {
    const chosen = Select([
      Voice('Microsoft Asaf', 'he-IL', true, true),
      Voice('Microsoft David Desktop', 'en-US'),
    ]);

    expect(chosen?.lang.startsWith('en')).toBe(true);
    expect(chosen?.name).not.toContain('Asaf');
  });

  it('returns null when no English voice is installed', () => {
    expect(Select([Voice('Microsoft Asaf', 'he-IL'), Voice('Google Deutsch', 'de-DE')])).toBeNull();
  });

  /** The whole reason this exists: neural voices are far better than SAPI ones. */
  it('prefers a neural voice over a legacy desktop voice', () => {
    const chosen = Select([
      Voice('Microsoft David Desktop', 'en-US', true, true),
      Voice('Microsoft Aria Online (Natural)', 'en-US', false),
    ]);

    expect(chosen?.name).toContain('Natural');
  });

  it('prefers a Google voice over a legacy desktop voice', () => {
    const chosen = Select([
      Voice('Microsoft Zira Desktop', 'en-US', true, true),
      Voice('Google US English', 'en-US', false),
    ]);

    expect(chosen?.name).toBe('Google US English');
  });

  it('falls back to a desktop voice when nothing better exists', () => {
    const chosen = Select([Voice('Microsoft David Desktop', 'en-US', true, true)]);
    expect(chosen?.name).toBe('Microsoft David Desktop');
  });

  it('prefers en-US over other English locales, all else equal', () => {
    const chosen = Select([Voice('Microsoft Hazel', 'en-GB'), Voice('Microsoft Michelle', 'en-US')]);
    expect(chosen?.lang).toBe('en-US');
  });

  it('handles an empty voice list', () => {
    expect(Select([])).toBeNull();
  });
});
