/**
 * Choosing which voice reads answers aloud.
 *
 * Pure ranking logic with no DOM dependency, so it can be unit tested from
 * the backend suite. Structurally compatible with SpeechSynthesisVoice - the
 * four fields below are all the ranking needs.
 */
export interface SelectableVoice {
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
}

/**
 * Picks the best available English voice.
 *
 * Two problems to solve. First, speechSynthesis otherwise defaults to a voice
 * matching the operating system locale, so on a machine configured for Hebrew
 * it reads English through a Hebrew voice - which sounds like a heavy accent
 * mangling every word. Second, quality varies enormously even within English:
 * Microsoft's "Natural" neural voices and Google's cloud voices are close to
 * human, while the legacy "Desktop" SAPI voices bundled with Windows are
 * robotic.
 */
export function SelectBestVoice<TVoice extends SelectableVoice>(voices: TVoice[]) {
  const english = voices.filter((voice) => voice.lang.toLowerCase().startsWith('en'));
  if (english.length === 0) return null;

  const ranked = [...english].sort((left, right) => ScoreVoice(right) - ScoreVoice(left));
  return ranked[0];
}

function ScoreVoice(voice: SelectableVoice) {
  const name = voice.name.toLowerCase();
  let score = 0;

  // Microsoft neural voices, by far the best available in Edge and Chrome.
  if (name.includes('natural')) score += 100;
  if (name.includes('google')) score += 60;
  // Named Microsoft online voices, also neural.
  if (/\b(aria|jenny|guy|michelle|ana|christopher|eric|steffan)\b/.test(name)) score += 25;
  // Cloud-backed voices generally beat local ones.
  if (!voice.localService) score += 20;
  // Legacy SAPI voices bundled with Windows: robotic.
  if (name.includes('desktop')) score -= 50;
  if (voice.lang.toLowerCase() === 'en-us') score += 10;
  if (voice.default) score += 2;

  return score;
}
