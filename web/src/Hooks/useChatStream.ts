import { useCallback, useRef, useState } from 'react';

import type { ChatStreamEvent, ChatTurn } from '../Types';

/**
 * Streams a conversation from the server.
 *
 * EventSource cannot be used here because it only issues GET requests and the
 * question is sent in a POST body, so the response body is read and the SSE
 * frames are parsed by hand. That is a handful of lines and avoids encoding
 * the question into a URL.
 */

const SessionId = `web-${Math.random().toString(36).slice(2, 10)}`;

export function useChatStream() {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const Send = useCallback(async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;

    setIsBusy(true);
    setTurns((previous) => [
      ...previous,
      { role: 'user', text: trimmed, toolCalls: [], isStreaming: false },
      { role: 'agent', text: '', toolCalls: [], isStreaming: true },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    /** Applies an update to the in-flight agent turn, which is always last. */
    const UpdateAgentTurn = (apply: (turn: ChatTurn) => ChatTurn) => {
      setTurns((previous) => {
        const next = [...previous];
        const index = next.length - 1;
        if (index >= 0 && next[index].role === 'agent') next[index] = apply(next[index]);
        return next;
      });
    };

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SessionId, question: trimmed }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Server responded ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line; a partial frame stays in
        // the buffer until the rest of it arrives.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
          if (!line) continue;

          const event = JSON.parse(line.slice(6)) as ChatStreamEvent;
          ApplyEvent(event, UpdateAgentTurn);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== 'The user aborted a request.') {
        UpdateAgentTurn((turn) => ({ ...turn, error: message, isStreaming: false }));
      }
    } finally {
      UpdateAgentTurn((turn) => ({ ...turn, isStreaming: false }));
      setIsBusy(false);
      abortRef.current = null;
    }
  }, []);

  const Stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const Reset = useCallback(async () => {
    abortRef.current?.abort();
    setTurns([]);
    await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SessionId }),
    });
  }, []);

  return { turns, isBusy, Send, Stop, Reset };
}

function ApplyEvent(event: ChatStreamEvent, update: (apply: (turn: ChatTurn) => ChatTurn) => void) {
  if (event.type === 'text' && event.text) {
    update((turn) => ({ ...turn, text: turn.text + event.text }));
    return;
  }

  if (event.type === 'tool_start' && event.toolName) {
    update((turn) => ({
      ...turn,
      toolCalls: [...turn.toolCalls, { name: event.toolName ?? '', input: event.toolInput, at: Date.now() }],
    }));
    return;
  }

  if (event.type === 'error') {
    update((turn) => ({ ...turn, error: event.message ?? 'Unknown error', isStreaming: false }));
  }
}
