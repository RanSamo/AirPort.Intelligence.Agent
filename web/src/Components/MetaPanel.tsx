import { useState } from 'react';

import type { AgentMeta } from '../Types';

/**
 * Data vintage, scoring configuration and stated limitations.
 *
 * Rendered from /api/meta rather than hard-coded, so the interface cannot
 * claim newer data or different weights than the backend actually holds.
 * The limitations are shown by default: the brief asks the agent to
 * communicate assumptions and scoping, and burying them behind a click
 * would defeat that.
 */
export function MetaPanel({ meta }: { meta: AgentMeta | null }) {
  const [showMetrics, setShowMetrics] = useState(false);

  if (!meta) return <div className="meta-loading">Connecting to the API…</div>;

  return (
    <div className="meta">
      <section>
        <h3>Data</h3>
        <dl>
          <dt>Passenger data</dt>
          <dd>
            through <strong>{meta.data.trafficThrough}</strong>
          </dd>
          <dt>Congestion data</dt>
          <dd>
            through <strong>{meta.data.congestionThrough}</strong>
          </dd>
          <dt>Airports with traffic</dt>
          <dd>{meta.data.airportsWithTraffic.toLocaleString()}</dd>
          <dt>Airports with congestion</dt>
          <dd>{meta.data.airportsWithCongestion.toLocaleString()}</dd>
        </dl>
      </section>

      <section>
        <h3>Scoring model</h3>
        <dl>
          <dt>Version</dt>
          <dd>
            v{meta.scoring.version} <span className="dim">({meta.scoring.scoreVersion})</span>
          </dd>
          <dt>Aggregation</dt>
          <dd>{meta.scoring.aggregation}</dd>
          <dt>Default profile</dt>
          <dd>{meta.scoring.defaultProfile}</dd>
          <dt>Materiality</dt>
          <dd>{meta.scoring.materiality}</dd>
          <dt>Spill k-factor</dt>
          <dd>{meta.scoring.spillKFactor}</dd>
          <dt>Sensitivity draws</dt>
          <dd>{meta.scoring.sensitivityDraws}</dd>
        </dl>

        <button className="link-button" type="button" onClick={() => setShowMetrics((open) => !open)}>
          {showMetrics ? 'Hide' : 'Show'} the {meta.metrics.length} metrics
        </button>

        {showMetrics ? (
          <ul className="metric-list">
            {meta.metrics.map((metric) => (
              <li key={metric.id}>
                <code>{metric.id}</code>
                <span className={`tag tag-${metric.provenance}`}>{metric.provenance}</span>
                <div className="dim">{metric.label}</div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section>
        <h3>What this cannot tell you</h3>
        <ul className="limitations">
          {meta.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
