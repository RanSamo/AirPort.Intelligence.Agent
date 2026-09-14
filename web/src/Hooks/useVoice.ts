import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BrowserVoiceRecognition, BrowserVoiceSpeech } from '../Services/VoiceProvider';
import { ExtractSpokenSummary } from '../Services/SpeechText';

/**
 * Voice input and spoken replies.
 *
 * Recognition and synthesis are separate capabilities with separate browser
 * support, so they are reported separately — Safari can speak but not listen,
 * and the interface should offer whichever half works rather than hiding both.
 */
export function useVoice() {
  const recognition = useMemo(() => new BrowserVoiceRecognition(), []);
  const speech = useMemo(() => new BrowserVoiceSpeech(), []);

  const [isListening, setIsListening] = useState(false);
  const [partialText, setPartialText] = useState('');
  const [isSpeakEnabled, setIsSpeakEnabled] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tracks what has already been spoken, so a streaming answer is not
  // re-read from the start on every token.
  const spokenRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      recognition.Stop();
      speech.Cancel();
    };
  }, [recognition, speech]);

  const StartListening = useCallback(
    (onFinal: (text: string) => void) => {
      setError(null);
      setPartialText('');
      setIsListening(true);
      // Never listen and talk at once - the microphone would hear the reply.
      speech.Cancel();

      recognition.Start({
        onPartial: (text) => setPartialText(text),
        onFinal: (text) => {
          setPartialText('');
          if (text) onFinal(text);
        },
        onError: (message) => {
          setError(message);
          setIsListening(false);
        },
        onEnd: () => {
          setIsListening(false);
          setPartialText('');
        },
      });
    },
    [recognition, speech],
  );

  const StopListening = useCallback(() => {
    recognition.Stop();
    setIsListening(false);
    setPartialText('');
  }, [recognition]);

  /**
   * Speaks only the opening summary of a completed answer.
   *
   * Waits for the turn to finish rather than speaking tokens as they arrive:
   * mid-stream text is frequently a half-formed sentence, and reading it
   * aloud sounds broken.
   */
  const SpeakAnswer = useCallback(
    (text: string, isComplete: boolean) => {
      if (!isSpeakEnabled || !isComplete || !text) return;
      if (spokenRef.current === text) return;

      spokenRef.current = text;
      speech.Speak(ExtractSpokenSummary(text));
      setIsSpeaking(true);

      // speechSynthesis has no reliable completion event across browsers,
      // so the flag is polled back down.
      const timer = window.setInterval(() => {
        if (!speech.isSpeaking) {
          setIsSpeaking(false);
          window.clearInterval(timer);
        }
      }, 300);
    },
    [isSpeakEnabled, speech],
  );

  const StopSpeaking = useCallback(() => {
    speech.Cancel();
    setIsSpeaking(false);
  }, [speech]);

  const ToggleSpeak = useCallback(() => {
    setIsSpeakEnabled((enabled) => {
      if (enabled) speech.Cancel();
      return !enabled;
    });
  }, [speech]);

  return {
    canListen: recognition.isSupported,
    canSpeak: speech.isSupported,
    voiceName: speech.voiceName,
    isListening,
    partialText,
    isSpeakEnabled,
    isSpeaking,
    error,
    StartListening,
    StopListening,
    SpeakAnswer,
    StopSpeaking,
    ToggleSpeak,
  };
}
