import type { FastifyInstance, FastifyReply } from 'fastify';

import { AgentService } from '../../Agent/AgentService';
import type { ChatStreamEvent } from '../../Types/Agent/Session';
import type { ScoringContainer } from '../../Container/CreateScoringContainer';

/**
 * Streaming chat endpoint.
 *
 * Tool calls are streamed as their own events, not just the prose. That is
 * what lets the UI show the agent's working — a reviewer can watch
 * deterministic tools produce the numbers being narrated, which is the whole
 * transparency argument of this project.
 */

interface AgentsBySession {
  [sessionId: string]: AgentService;
}

interface ChatRequestBody {
  sessionId?: string;
  question?: string;
}

export function RegisterChatRoute(app: FastifyInstance, container: ScoringContainer, apiKey: string) {
  // One agent per session so conversation history and resolved entities
  // survive across turns. In-memory is the right scope here: sessions are
  // per-browser-tab and nothing needs to outlive the process.
  const agents: AgentsBySession = {};

  const ResolveAgent = (sessionId: string) => {
    const existing = agents[sessionId];
    if (existing) return existing;

    const created = new AgentService(container, apiKey);
    agents[sessionId] = created;
    return created;
  };

  app.post('/api/chat', async (request, reply) => {
    const body = (request.body ?? {}) as ChatRequestBody;
    const question = (body.question ?? '').trim();
    const sessionId = body.sessionId ?? 'default';

    if (!question) {
      await reply.status(400).send({ error: 'A question is required.' });
      return;
    }

    StartEventStream(reply);
    const agent = ResolveAgent(sessionId);

    try {
      for await (const event of agent.Ask(question)) {
        WriteEvent(reply, event);
      }
    } catch (error) {
      WriteEvent(reply, {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      reply.raw.end();
    }
  });

  app.post('/api/reset', async (request, reply) => {
    const body = (request.body ?? {}) as ChatRequestBody;
    const sessionId = body.sessionId ?? 'default';
    delete agents[sessionId];
    await reply.send({ reset: true });
  });
}

function StartEventStream(reply: FastifyReply) {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Without this, nginx-style proxies buffer the whole response and the
    // stream arrives as a single blob at the end.
    'X-Accel-Buffering': 'no',
  });
}

function WriteEvent(reply: FastifyReply, event: ChatStreamEvent) {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}
