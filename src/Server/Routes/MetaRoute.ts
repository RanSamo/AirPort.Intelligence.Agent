import type { FastifyInstance } from 'fastify';

import { AllMetricIds, MetricsById } from '../../Metrics/MetricRegistry';
import type { ScoringContainer } from '../../Container/CreateScoringContainer';

/**
 * Describes the snapshot and the scoring model to the UI.
 *
 * The front end renders data vintages and the methodology panel from this
 * rather than hard-coding them, so the interface can never claim newer data
 * or different weights than the backend actually holds.
 */
export function RegisterMetaRoute(app: FastifyInstance, container: ScoringContainer) {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/meta', async () => {
    const traffic = container.trafficRepository.GetAvailableRange();
    const congestion = container.congestionRepository.GetAvailableRange();

    const airports = container.database
      .Prepare<{ total: number; withCongestion: number }>(
        `SELECT (SELECT COUNT(*) FROM airports WHERE annual_enplanements > 0)  AS total,
                (SELECT COUNT(*) FROM airports WHERE reports_otp = 1)          AS withCongestion`,
      )
      .get();

    return {
      data: {
        trafficThrough: traffic.to,
        congestionThrough: congestion.to,
        trafficFrom: traffic.from,
        congestionFrom: congestion.from,
        airportsWithTraffic: airports?.total ?? 0,
        airportsWithCongestion: airports?.withCongestion ?? 0,
      },
      scoring: {
        version: container.config.version,
        scoreVersion: container.scoreVersion,
        aggregation: container.config.aggregation,
        defaultProfile: container.config.defaultProfile,
        materiality: container.config.scale.weighting,
        spillKFactor: container.config.spill.kFactor,
        sensitivityDraws: container.config.sensitivity.draws,
      },
      metrics: AllMetricIds.map((metricId) => {
        const definition = MetricsById[metricId];
        return {
          id: metricId,
          label: definition.label,
          pillar: definition.pillar,
          provenance: definition.provenance,
          description: definition.description,
        };
      }),
      limitations: [
        'No public data exists on construction cost, so this ranks relative expansion opportunity, not return on investment.',
        'BTS On-Time Performance covers domestic flights only. All congestion, taxi-time and haul-mix figures exclude international departures.',
        'Spill estimates are a lower bound and cannot be attributed to specific routes.',
        'Gate counts are not published by any public API, so no metric depends on them.',
        'Catchment demographics are omitted: no clean public airport-to-metro crosswalk exists.',
      ],
    };
  });
}
