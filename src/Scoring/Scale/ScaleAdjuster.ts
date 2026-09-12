import type { Airport } from '../../Types/Domain/Airport';
import type { ScaleConfig, ScaleWeighting } from '../../Types/Scoring/ScoringConfig';

/**
 * Materiality adjustment — how much absolute passenger volume counts.
 *
 * WHY THIS EXISTS. Metrics are normalized within each airport's FAA hub-class
 * cohort, which is what makes a Small hub comparable to a Large one. The side
 * effect is that the resulting score measures *intensity* relative to peers,
 * not the size of the prize. Unadjusted, Bangor (p97 of nonhubs, ~250k
 * passengers) outranked Boston Logan (p83 of large hubs, ~22M) as a terminal
 * expansion candidate. Both readings are internally valid, but only one
 * answers an investor asking where renovation capital is best deployed.
 *
 * WHY LOGARITHMIC. Boston carries roughly 90x Bangor's passengers. Weighting
 * linearly would make the ranking a passenger-count league table and discard
 * every signal the three pillars work to produce. A log tilt says "bigger
 * matters, proportionally less as you go up", which is how deployable capital
 * actually behaves.
 *
 * Applied as a multiplier alongside feasibility so it stays visible in the
 * score waterfall rather than hiding inside a pillar.
 */
export class ScaleAdjuster {
  private readonly config: ScaleConfig;
  private readonly logFloor: number;
  private readonly logSpan: number;

  constructor(config: ScaleConfig) {
    this.config = config;
    this.logFloor = Math.log10(Math.max(1, config.floorEnplanements));
    this.logSpan = Math.log10(Math.max(1, config.ceilingEnplanements)) - this.logFloor;
  }

  public Resolve(airport: Airport, weighting?: ScaleWeighting) {
    const mode = weighting ?? this.config.weighting;
    const band = this.config.bands[mode];

    if (!band || mode === 'none') {
      return { multiplier: 1, narrative: 'Volume ignored: airports are compared on intensity alone.' };
    }

    const position = this.NormalizedPosition(airport.annualEnplanements);
    const multiplier = band.min + (band.max - band.min) * position;

    return {
      multiplier,
      narrative: this.Describe(airport, multiplier),
    };
  }

  /** Position of this airport between the floor and ceiling, on a log scale, 0-1. */
  private NormalizedPosition(enplanements: number) {
    if (enplanements <= 0 || this.logSpan <= 0) return 0;
    const raw = (Math.log10(enplanements) - this.logFloor) / this.logSpan;
    return Math.min(1, Math.max(0, raw));
  }

  private Describe(airport: Airport, multiplier: number) {
    const passengers = Math.round(airport.annualEnplanements).toLocaleString();

    if (multiplier >= 1.02) {
      return `Scaled up for materiality: ${passengers} annual passengers supports a larger capital programme than a typical airport.`;
    }
    if (multiplier <= 0.98) {
      return `Scaled down for materiality: at ${passengers} annual passengers the absolute opportunity is smaller, even where the case is strong relative to its peers.`;
    }
    return `Roughly neutral on materiality at ${passengers} annual passengers.`;
  }
}
