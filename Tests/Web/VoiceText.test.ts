import { describe, expect, it } from 'vitest';

import { ExtractSpokenSummary, StripMarkdown } from '../../web/src/Services/SpeechText';

/**
 * Text processing for spoken replies.
 *
 * Pure functions, and the difference between usable and unbearable voice
 * output. Without stripping, the synthesizer reads "asterisk asterisk BOS
 * asterisk asterisk" and every pipe character in a ranking table.
 */
describe('StripMarkdown', () => {
  it('removes bold, italic and code markers', () => {
    expect(StripMarkdown('**BOS** scores *highest* with `rank_airports`')).toBe(
      'BOS scores highest with rank_airports',
    );
  });

  it('drops table rows entirely', () => {
    const answer = [
      'Boston leads the ranking.',
      '| Code | Score |',
      '| --- | --- |',
      '| BOS | 72.4 |',
      'Bangor is second.',
    ].join('\n');

    const spoken = StripMarkdown(answer);
    expect(spoken).toBe('Boston leads the ranking. Bangor is second.');
    expect(spoken).not.toContain('|');
  });

  it('removes heading and bullet markers', () => {
    expect(StripMarkdown('## Findings\n- First point\n- Second point')).toBe('Findings First point Second point');
  });

  it('collapses whitespace so the synthesizer does not pause oddly', () => {
    expect(StripMarkdown('One.\n\n\nTwo.')).toBe('One. Two.');
  });

  it('leaves plain prose untouched', () => {
    const plain = 'SFO is spilling roughly 3.2 million passengers a year.';
    expect(StripMarkdown(plain)).toBe(plain);
  });
});

describe('ExtractSpokenSummary', () => {
  /**
   * The system prompt asks every answer to open with a two-sentence summary
   * precisely so there is something worth reading aloud. Speaking the whole
   * reply - tables, percentages, caveats - is unusable.
   */
  it('takes only the opening sentences', () => {
    const answer =
      'Boston Logan is the strongest candidate. It scores 72.4, the 83rd percentile of large hubs. ' +
      'Bangor is second at 66.5. Portland and Providence are effectively tied.';

    const summary = ExtractSpokenSummary(answer);
    expect(summary).toBe('Boston Logan is the strongest candidate. It scores 72.4, the 83rd percentile of large hubs.');
    expect(summary).not.toContain('Bangor');
  });

  it('strips formatting before summarising', () => {
    const summary = ExtractSpokenSummary('**SFO leads.** It scores 85.2. Others follow.');
    expect(summary).not.toContain('*');
    expect(summary.startsWith('SFO leads.')).toBe(true);
  });

  it('handles an answer with no sentence punctuation', () => {
    const summary = ExtractSpokenSummary('SFO leads the ranking');
    expect(summary).toBe('SFO leads the ranking');
  });

  /**
   * Almost every answer this system produces is dense with decimals, so
   * splitting on them would truncate the spoken summary mid-number on most
   * replies. This is the single most important case here.
   */
  it('does not split sentences on decimal points', () => {
    const answer = 'BOS scores 72.4 on the terminal profile. Bangor follows.';
    expect(ExtractSpokenSummary(answer, 1)).toBe('BOS scores 72.4 on the terminal profile.');
  });

  it('keeps percentages and multiple decimals intact', () => {
    const answer = 'SFO spills 10.6% of demand, peaking at 19.5% in June. That is roughly 3.2 million passengers.';
    const summary = ExtractSpokenSummary(answer, 1);

    expect(summary).toContain('10.6%');
    expect(summary).toContain('19.5%');
    expect(summary).not.toContain('3.2 million');
  });

  it('respects a custom sentence count', () => {
    const answer = 'One. Two. Three. Four.';
    expect(ExtractSpokenSummary(answer, 1)).toBe('One.');
    expect(ExtractSpokenSummary(answer, 3)).toBe('One. Two. Three.');
  });

  it('returns something speakable for an empty answer', () => {
    expect(ExtractSpokenSummary('')).toBe('');
  });
});
