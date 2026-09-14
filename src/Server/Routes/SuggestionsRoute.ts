import type { FastifyInstance } from 'fastify';

import { DefaultPeriodId } from '../../Agent/Tools/ToolContext';
import { SuggestionBuilder } from '../../Suggestions/SuggestionBuilder';
import type { ScoringContainer } from '../../Container/CreateScoringContainer';
import type { SuggestionSet } from '../../Types/Agent/Suggestion';

/**
 * Opening questions for the interface.
 *
 * Computed once at startup and cached. The snapshot is static between
 * ingests, so recomputing per request would repeat identical work — and
 * caching also guarantees every visitor sees the same figures, which is the
 * behaviour a reproducible system should have.
 */
export function RegisterSuggestionsRoute(app: FastifyInstance, container: ScoringContainer) {
  const builder = new SuggestionBuilder(
    container.airportRepository,
    container.metricRepository,
    container.scoringEngine,
    container.config,
  );

  let cached: SuggestionSet | null = null;

  app.get('/api/suggestions', async () => {
    if (!cached) {
      const traffic = container.trafficRepository.GetAvailableRange();
      cached = builder.Build(DefaultPeriodId, traffic.to);
    }
    return cached;
  });
}
