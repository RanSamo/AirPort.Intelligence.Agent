import { SelectBestVoice } from './VoiceSelection';
import { StripMarkdown } from './SpeechText';

/**
 * Voice input and output.
 *
 * Uses the browser's built-in Web Speech API: no API key, no server round
 * trip, no cost, and nothing to break at demo time. The trade is browser
 * support - recognition is Chrome/Edge only, and Safari's is partial.
 *
 * Everything sits behind this interface so a hosted provider (Deepgram,
 * ElevenLabs, the OpenAI realtime API) can be dropped in by writing one more
 * implementation, without the chat components changing at all.
 *
 * Pure text processing lives in SpeechText.ts, so it can be unit tested
 * without pulling DOM typings into the backend test suite.
 */

export interface VoiceRecognition {
  readonly isSupported: boolean;
  Start(handlers: RecognitionHandlers): void;
  Stop(): void;
}

export interface RecognitionHandlers {
  /** Fires repeatedly as the user speaks, so the input can update live. */
  onPartial: (text: string) => void;
  /** Fires once with the final transcript. */
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}

export interface VoiceSpeech {
  readonly isSupported: boolean;
  Speak(text: string): void;
  Cancel(): void;
  readonly isSpeaking: boolean;
  /** Which voice was selected, so the interface can show it. */
  readonly voiceName: string;
}

// The Web Speech API is not in the standard DOM typings, and the constructor
// is still vendor-prefixed in Chrome.
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: { isFinal: boolean; 0: { transcript: string } };
  };
}

interface SpeechWindow {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
}

function ResolveRecognitionConstructor() {
  const speechWindow = window as unknown as SpeechWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

export class BrowserVoiceRecognition implements VoiceRecognition {
  public readonly isSupported: boolean;
  private recognition: SpeechRecognitionLike | null = null;

  constructor() {
    this.isSupported = ResolveRecognitionConstructor() !== null;
  }

  public Start(handlers: RecognitionHandlers) {
    const Constructor = ResolveRecognitionConstructor();
    if (!Constructor) {
      handlers.onError('Speech recognition is not supported in this browser. Chrome or Edge is required.');
      return;
    }

    this.Stop();

    const recognition = new Constructor();
    recognition.lang = 'en-US';
    // Single utterance: the user asks one question, not a dictation session.
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let interim = '';
      let final = '';

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }

      if (interim) handlers.onPartial(interim);
      if (final) handlers.onFinal(final.trim());
    };

    recognition.onerror = (event) => {
      // 'aborted' fires whenever we stop it deliberately, and 'no-speech'
      // when the user simply said nothing. Neither is worth surfacing.
      if (event.error === 'aborted' || event.error === 'no-speech') return;
      handlers.onError(DescribeRecognitionError(event.error));
    };

    recognition.onend = () => handlers.onEnd();

    this.recognition = recognition;
    recognition.start();
  }

  public Stop() {
    if (!this.recognition) return;
    this.recognition.onresult = null;
    this.recognition.onerror = null;
    this.recognition.onend = null;
    this.recognition.abort();
    this.recognition = null;
  }
}

function DescribeRecognitionError(code: string) {
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    return 'Microphone access was denied. Allow it in your browser settings to use voice input.';
  }
  if (code === 'network') return 'Speech recognition needs a network connection.';
  if (code === 'audio-capture') return 'No microphone was found.';
  return `Speech recognition failed (${code}).`;
}

export class BrowserVoiceSpeech implements VoiceSpeech {
  public readonly isSupported: boolean;
  private speaking = false;
  private voice: SpeechSynthesisVoice | null = null;

  constructor() {
    this.isSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    if (this.isSupported) this.LoadVoice();
  }

  public get isSpeaking() {
    return this.speaking;
  }

  /** Name of the voice in use, for display. */
  public get voiceName() {
    return this.voice?.name ?? 'system default';
  }

  public Speak(text: string) {
    if (!this.isSupported) return;

    this.Cancel();

    const utterance = new SpeechSynthesisUtterance(StripMarkdown(text));

    // Setting the voice explicitly is essential, not cosmetic. Left alone,
    // speechSynthesis picks a voice matching the operating system locale -
    // so on a machine set to Hebrew it reads English through a Hebrew voice,
    // which sounds like a heavy accent mangling every word.
    if (!this.voice) this.LoadVoice();
    if (this.voice) utterance.voice = this.voice;

    utterance.lang = this.voice?.lang ?? 'en-US';
    utterance.rate = 1.0;
    utterance.pitch = 1;

    utterance.onend = () => {
      this.speaking = false;
    };
    utterance.onerror = () => {
      this.speaking = false;
    };

    this.speaking = true;
    window.speechSynthesis.speak(utterance);
  }

  public Cancel() {
    if (!this.isSupported) return;
    window.speechSynthesis.cancel();
    this.speaking = false;
  }

  /**
   * getVoices() returns an empty list until the browser has loaded them, so
   * the selection is retried on the voiceschanged event.
   */
  private LoadVoice() {
    const apply = () => {
      const chosen = SelectBestVoice(window.speechSynthesis.getVoices());
      if (chosen) this.voice = chosen;
    };

    apply();
    if (!this.voice) window.speechSynthesis.addEventListener('voiceschanged', apply, { once: true });
  }
}


