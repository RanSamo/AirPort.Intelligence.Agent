import { useEffect, useRef, useState } from 'react';

import { AgentTrace } from './Components/AgentTrace';
import { MicrophoneIcon, SpeakerIcon, StopIcon } from './Components/Icons';
import { Markdown } from './Components/Markdown';
import { MetaPanel } from './Components/MetaPanel';
import { Suggestions } from './Components/Suggestions';
import { useChatStream } from './Hooks/useChatStream';
import { useVoice } from './Hooks/useVoice';
import type { AgentMeta } from './Types';

export function App() {
  const { turns, isBusy, Send, Stop, Reset } = useChatStream();
  const voice = useVoice();
  const [draft, setDraft] = useState('');
  const [meta, setMeta] = useState<AgentMeta | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const lastTurn = turns[turns.length - 1];

  // Speak the opening summary once a reply has finished streaming.
  useEffect(() => {
    if (!lastTurn || lastTurn.role !== 'agent' || lastTurn.isStreaming) return;
    voice.SpeakAnswer(lastTurn.text, true);
  }, [lastTurn?.text, lastTurn?.isStreaming, lastTurn?.role, voice]);

  useEffect(() => {
    fetch('/api/meta')
      .then((response) => response.json())
      .then((payload: AgentMeta) => setMeta(payload))
      .catch(() => setMeta(null));
  }, []);

  // Follow the conversation as it streams.
  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  const Submit = async (question: string) => {
    if (isBusy) return;
    setDraft('');
    await Send(question);
  };

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Airport Investment Intelligence Agent</h1>
          <p className="subtitle">
            Ranks US airports by expansion opportunity. Every figure comes from BTS and FAA data through a
            deterministic scoring engine — the model narrates, it does not compute.
          </p>
        </div>
        <div className="header-actions">
          {voice.canSpeak ? (
            <button
              className={`ghost-button icon-button ${voice.isSpeakEnabled ? 'active' : ''}`}
              type="button"
              onClick={voice.ToggleSpeak}
              title={
                voice.isSpeakEnabled
                  ? `Reading answers aloud using ${voice.voiceName}`
                  : 'Read the opening summary of each answer aloud'
              }
            >
              <SpeakerIcon muted={!voice.isSpeakEnabled} />
              {voice.isSpeakEnabled ? 'Speaking on' : 'Speak replies'}
            </button>
          ) : null}
          <button className="ghost-button" type="button" onClick={Reset} disabled={isBusy}>
            New conversation
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="chat">
          <div className="transcript" ref={transcriptRef}>
            {turns.length === 0 ? (
              <div className="welcome">
                <h2>Ask about US airport expansion opportunities</h2>
                <p>
                  The agent resolves place names, ranks airports with a deterministic engine, explains every
                  score term by term, and tests whether a ranking is robust or an artefact of the weights.
                </p>
                <Suggestions onPick={(question) => void Submit(question)} />
              </div>
            ) : null}

            {turns.map((turn, index) =>
              turn.role === 'user' ? (
                <div className="turn user" key={index}>
                  <div className="bubble">{turn.text}</div>
                </div>
              ) : (
                <div className="turn agent" key={index}>
                  <AgentTrace toolCalls={turn.toolCalls} isStreaming={turn.isStreaming && !turn.text} />
                  {turn.text ? <Markdown text={turn.text} /> : null}
                  {turn.error ? <div className="error">{turn.error}</div> : null}
                </div>
              ),
            )}
          </div>

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void Submit(draft);
            }}
          >
            <input
              value={voice.isListening && voice.partialText ? voice.partialText : draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={voice.isListening ? 'Listening…' : 'Ask about airport expansion opportunities…'}
              disabled={isBusy || voice.isListening}
              autoFocus
            />

            {voice.canListen ? (
              <button
                type="button"
                className={`mic ${voice.isListening ? 'listening' : ''}`}
                onClick={() =>
                  voice.isListening
                    ? voice.StopListening()
                    : voice.StartListening((spoken) => void Submit(spoken))
                }
                disabled={isBusy}
                title={voice.isListening ? 'Stop listening' : 'Ask by voice'}
                aria-label={voice.isListening ? 'Stop listening' : 'Ask by voice'}
              >
                {voice.isListening ? <StopIcon size={20} /> : <MicrophoneIcon size={26} />}
              </button>
            ) : null}

            {isBusy ? (
              <button type="button" className="stop" onClick={Stop}>
                Stop
              </button>
            ) : (
              <button type="submit" disabled={!draft.trim()}>
                Ask
              </button>
            )}
          </form>

          {voice.error ? <div className="voice-error">{voice.error}</div> : null}
          {voice.isSpeaking ? (
            <button type="button" className="voice-stop" onClick={voice.StopSpeaking}>
              Stop speaking
            </button>
          ) : null}
        </section>

        <aside className="sidebar">
          <MetaPanel meta={meta} />
        </aside>
      </main>
    </div>
  );
}
