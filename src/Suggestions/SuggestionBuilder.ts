import type { Airport } from '../Types/Domain/Airport';
import type { IAirportRepository, IMetricRepository } from '../Types/Ports/Repositories';
import type { MetricId, MetricValuesByMetricAndAirport } from '../Types/Domain/Metric';
import type { ScoringConfig } from '../Types/Scoring/ScoringConfig';
import type { ScoringEngine } from '../Scoring/ScoringEngine';
import type { Suggestion, SuggestionSet } from '../Types/Agent/Suggestion';

/**
 * Builds opening questions from real findings in the snapshot.
 *
 * The point is the difference between a prompt and a finding. "Which airports
 * grew fastest?" is something any chatbot shell could offer; "BOI has grown
 * 14.2% a year for three years - what is driving it?" proves the system has
 * already read its data.
 *
 * PASSENGER FLOORS ARE NOT OPTIONAL HERE. A screen sorts for extremes, and
 * percentage changes are wildly unstable on small bases - one new route at a
 * 200-passenger airfield reads as 400% growth. Each computed suggestion sets
 * a floor appropriate to its metric.
 */

/** Growth is the most volatile metric, so it gets the highest floor. */
const GrowthFloor = 1_000_000;
/** Floors for the remaining computed suggestions. */
const MajorAirportFloor = 2_500_000;

export class SuggestionBuilder {
  private readonly airports: IAirportRepository;
  private readonly metrics: IMetricRepository;
  private readonly engine: ScoringEngine;
  private readonly config: ScoringConfig;

  constructor(
    airports: IAirportRepository,
    metrics: IMetricRepository,
    engine: ScoringEngine,
    config: ScoringConfig,
  ) {
    this.airports = airports;
    this.metrics = metrics;
    this.engine = engine;
    this.config = config;
  }

  public Build(periodId: string, trafficThrough: string) {
    const values = this.metrics.GetAllForPeriod(periodId);
    const computed = [
      this.TopCandidate(periodId),
      this.FastestGrowing(values),
      this.LargestSpill(values),
      this.MostSystemCauseCongestion(values),
      this.MostConstrainedHub(values),
    ].filter((suggestion): suggestion is Suggestion => suggestion !== null);

    const set: SuggestionSet = {
      suggestions: [...computed, ...this.Generic()],
      basedOn: `snapshot through ${trafficThrough}`,
    };
    return set;
  }

  /** The strongest national candidate, which is the obvious opening question. */
  private TopCandidate(periodId: string) {
    const candidates = this.airports.Find({
      minAnnualPassengers: MajorAirportFloor,
      limit: this.config.universe.nationalCandidateLimit,
    });
    if (candidates.length === 0) return null;

    const result = this.engine.Rank({ airports: candidates, periodId, overrides: {}, topN: 1 });
    const leader = result.scores[0];
    if (!leader) return null;

    return this.Make(
      'top-candidate',
      `Why is ${leader.iata} our strongest expansion candidate right now?`,
      'computed',
      `${leader.airportName} scores ${leader.score.toFixed(1)}, the ${Ordinal(leader.cohortPercentile)} percentile of ${leader.hubClass.toLowerCase()} hubs.`,
    );
  }

  private FastestGrowing(values: MetricValuesByMetricAndAirport) {
    const best = this.Extreme(values, 'enplanement_cagr_3y', GrowthFloor, 'highest');
    if (!best || best.value <= 0) return null;

    return this.Make(
      'fastest-growth',
      `${best.airport.iata} has grown ${(best.value * 100).toFixed(1)}% a year for three years. What is driving it, and can the airport absorb more?`,
      'computed',
      `${best.airport.name} has the fastest passenger growth of any airport above one million passengers.`,
    );
  }

  private LargestSpill(values: MetricValuesByMetricAndAirport) {
    const best = this.Extreme(values, 'spill_rate', MajorAirportFloor, 'highest');
    if (!best) return null;

    return this.Make(
      'largest-spill',
      `${best.airport.iata} appears to be turning away demand. How much, and what is the constraint?`,
      'computed',
      `Estimated spill rate of ${(best.value * 100).toFixed(1)}%, the highest among major airports.`,
    );
  }

  /**
   * System-cause delay share is the sharpest question in the whole model:
   * it separates congestion capital can fix from congestion it cannot.
   */
  private MostSystemCauseCongestion(values: MetricValuesByMetricAndAirport) {
    const best = this.Extreme(values, 'nas_delay_share', MajorAirportFloor, 'highest');
    if (!best) return null;

    return this.Make(
      'system-cause',
      `${(best.value * 100).toFixed(0)}% of ${best.airport.iata}'s delay minutes are system-cause rather than weather. Is that fixable with capital?`,
      'computed',
      `${best.airport.name} has the highest infrastructure-driven delay share among major airports.`,
    );
  }

  private MostConstrainedHub(values: MetricValuesByMetricAndAirport) {
    const best = this.Extreme(values, 'taxi_out_p90', MajorAirportFloor, 'highest');
    if (!best) return null;

    return this.Make(
      'relief-play',
      `If we cannot get capacity at ${best.airport.iata}, which nearby airport could absorb the overflow?`,
      'computed',
      `Taxi-out reaches ${best.value.toFixed(0)} minutes at the 90th percentile, the worst among major airports.`,
    );
  }

  /** Fixed starting points covering paths the computed ones do not. */
  private Generic(): Suggestion[] {
    return [
      this.Make(
        'secondary-markets',
        'We want secondary-market exposure. What are the best opportunities outside the large hubs?',
        'generic',
      ),
      this.Make('west-coast', 'Compare the major West Coast gateways on congestion and growth.', 'generic'),
      this.Make(
        'methodology',
        'How does your scoring work, and where is it most likely to be wrong?',
        'generic',
        'Asks the agent to explain its own methodology and limitations.',
      ),
    ];
  }

  /** Highest or lowest value for a metric, above a passenger floor. */
  private Extreme(
    values: MetricValuesByMetricAndAirport,
    metricId: MetricId,
    minAnnualPassengers: number,
    direction: 'highest' | 'lowest',
  ) {
    const byAirport = values[metricId];
    if (!byAirport) return null;

    const eligible = this.airports.Find({ minAnnualPassengers });

    return eligible.reduce((best: { airport: Airport; value: number } | null, airport) => {
      const value = byAirport[airport.iata];
      if (value === undefined) return best;
      if (best === null) return { airport, value };

      const isBetter = direction === 'highest' ? value > best.value : value < best.value;
      return isBetter ? { airport, value } : best;
    }, null);
  }

  /**
   * Kind is stated explicitly rather than inferred from whether a rationale
   * exists: a fixed question can still carry an explanatory note, and
   * labelling it "computed" would overstate what the system derived.
   */
  private Make(id: string, question: string, kind: Suggestion['kind'], rationale?: string): Suggestion {
    return { id, question, kind, rationale };
  }
}

function Ordinal(value: number) {
  const rounded = Math.round(value);
  const remainder = rounded % 100;
  if (remainder >= 11 && remainder <= 13) return `${rounded}th`;

  const suffix = ['th', 'st', 'nd', 'rd'][rounded % 10] ?? 'th';
  return `${rounded}${rounded % 10 <= 3 ? suffix : 'th'}`;
}
