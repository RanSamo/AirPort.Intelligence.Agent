import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';

import { CreateScoringContainer } from '../Container/CreateScoringContainer';
import { RegisterChatRoute } from './Routes/ChatRoute';
import { RegisterMetaRoute } from './Routes/MetaRoute';
import { RegisterSuggestionsRoute } from './Routes/SuggestionsRoute';

/**
 * Backend for the web interface.
 *
 *   npm run server        # then npm run web, or npm run dev for both
 *
 * The CLI (npm run chat) talks to the same AgentService, so the two
 * interfaces cannot drift apart in behaviour.
 */

const Port = Number(process.env.PORT ?? 3001);

async function Main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.\n');
    process.exit(1);
  }

  const container = CreateScoringContainer({ logLevel: 'info' });
  const app = Fastify({ logger: false });

  // The Vite dev server runs on its own port, so the browser origin differs.
  await app.register(cors, { origin: true });

  RegisterMetaRoute(app, container);
  RegisterSuggestionsRoute(app, container);
  RegisterChatRoute(app, container, apiKey);

  const traffic = container.trafficRepository.GetAvailableRange();
  const congestion = container.congestionRepository.GetAvailableRange();

  await app.listen({ port: Port, host: '0.0.0.0' });

  process.stdout.write(`\nAirport Intelligence Agent API\n`);
  process.stdout.write(`  listening   http://localhost:${Port}\n`);
  process.stdout.write(`  traffic     through ${traffic.to}\n`);
  process.stdout.write(`  congestion  through ${congestion.to}\n`);
  process.stdout.write(`  scoring     v${container.config.version} (${container.config.aggregation})\n\n`);

  const Shutdown = async () => {
    await app.close();
    container.database.Close();
    process.exit(0);
  };

  process.on('SIGINT', Shutdown);
  process.on('SIGTERM', Shutdown);
}

Main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`\nServer failed to start:\n${message}\n`);
  process.exit(1);
});
