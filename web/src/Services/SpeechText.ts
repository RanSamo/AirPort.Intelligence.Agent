/**
 * Text preparation for spoken replies.
 *
 * Pure string functions with no browser dependency, kept separate from
 * VoiceProvider so they can be unit tested from the backend test suite
 * without pulling DOM typings into it.
 */

/**
 * Strips Markdown before speaking.
 *
 * Without this the synthesizer reads "asterisk asterisk BOS asterisk
 * asterisk" and every pipe character in a table. Tables are dropped whole
 * rather than read aloud - a spoken ranked table is unusable.
 */
export function StripMarkdown(text: string) {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('|'))
    .join('\n')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The opening summary, which is all that should ever be spoken.
 *
 * The system prompt asks every answer to start with a two-sentence summary
 * precisely so there is something worth reading aloud. Speaking a full
 * response - with its tables, percentages and caveats - is unbearable.
 */
export function ExtractSpokenSummary(text: string, maxSentences = 2) {
  const cleaned = StripMarkdown(text);
  const sentences = SplitSentences(cleaned);
  if (sentences.length === 0) return cleaned.slice(0, 300);

  return sentences.slice(0, maxSentences).join(' ');
}

/**
 * Splits prose into sentences without breaking on decimal points.
 *
 * A naive /[^.!?]+[.!?]+/ split cuts "It scores 72.4" into "It scores 72."
 * — which matters enormously here, because almost every answer this system
 * produces is dense with decimals: scores, percentages, load factors, taxi
 * times. The summary would be truncated mid-number on most replies.
 *
 * Requiring whitespace and then a capital letter after the terminator keeps
 * "72.4" intact, since what follows its period is a digit.
 */
function SplitSentences(text: string) {
  if (!text.trim()) return [];

  return text
    .split(/(?<=[.!?])\s+(?=["'(]?[A-Z])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}
