import { BuildCitation } from '../../Config/SourceCitations';
import { ShiftMonthKey } from '../../Infrastructure/Time/MonthSequence';
import type { DataSourceId } from '../../Types/Data/Source';
import type { ExclusionReason } from '../../Types/Data/Coverage';
import type { ScoringContainer } from '../../Container/CreateScoringContainer';
import type { ToolEnvelope, ToolMeta } from '../../Types/Agent/Tool';

/** The analysis period every tool reports against. */
export const DefaultPeriodId = 'latest_12m';

export interface EnvelopeOptions {
  sources: DataSourceId[];
  caveats?: string[];
  exclusions?: ExclusionReason[];
  coverage?: number;
  cached?: boolean;
}

/**
 * Shared state and helpers for every tool.
 *
 * Data vintages are read from the snapshot once at construction so that no
 * tool can cite newer data than was actually ingested — a class of mistake
 * that would be invisible in the output.
 */
export class ToolContext {
  public readonly container: ScoringContainer;
  /** Everything the snapshot holds - 11+ years. Only for explicitly historical questions. */
  public readonly trafficRange: { from: string; to: string };
  /**
   * The last 12 months of traffic.
   *
   * This is what "currently" means, and it is what almost every tool should
   * use. Reading the full range instead silently averages today's answer with
   * the 2020 collapse: it reported Anchorage as 1.2% international when the
   * current figure is 0.2%, and would have made every spill estimate a
   * decade-wide average rather than a description of now.
   */
  public readonly recentTrafficRange: { from: string; to: string };
  public readonly congestionRange: { from: string; to: string };

  constructor(container: ScoringContainer) {
    this.container = container;
    this.trafficRange = container.trafficRepository.GetAvailableRange();
    this.congestionRange = container.congestionRepository.GetAvailableRange();
    this.recentTrafficRange = {
      from: ShiftMonthKey(this.trafficRange.to, -11),
      to: this.trafficRange.to,
    };
  }

  /** Human-readable data vintage, e.g. "traffic through 2026-04; congestion through 2026-06". */
  public AsOf() {
    return `traffic data through ${this.trafficRange.to}; congestion data through ${this.congestionRange.to}`;
  }

  /** The window current-state answers describe. */
  public RecentWindowLabel() {
    return `${this.recentTrafficRange.from} to ${this.recentTrafficRange.to}`;
  }

  public CoverageThroughFor(sourceId: DataSourceId) {
    if (sourceId === 'bts_otp') return this.congestionRange.to;
    if (sourceId === 't100_socrata') return this.trafficRange.to;
    return 'current';
  }

  public Wrap<TData>(data: TData, options: EnvelopeOptions) {
    const meta: ToolMeta = {
      sources: options.sources.map((sourceId) => BuildCitation(sourceId, this.CoverageThroughFor(sourceId))),
      asOf: this.AsOf(),
      coverage: options.coverage ?? 1,
      exclusions: options.exclusions ?? [],
      caveats: options.caveats ?? [],
      cached: options.cached ?? false,
    };

    const envelope: ToolEnvelope<TData> = { data, meta };
    return envelope;
  }

  /**
   * Resolves user-supplied codes to airports, reporting which ones failed.
   * Aliases are handled by the repository, so BTS-era codes still work.
   */
  public ResolveCodes(codes: string[]) {
    return codes.reduce(
      (accumulator: { found: ReturnType<ScoringContainer['airportRepository']['GetByCode']>[]; missing: string[] }, code) => {
        const airport = this.container.airportRepository.GetByCode(code);
        if (airport) accumulator.found.push(airport);
        else accumulator.missing.push(code.toUpperCase());
        return accumulator;
      },
      { found: [], missing: [] },
    );
  }
}

/** Standing caveats that apply wherever the relevant data is used. */
export const Caveats = {
  domesticOnly:
    'BTS On-Time Performance covers domestic flights only, so congestion and haul-mix figures exclude international departures. At an airport like JFK (54% international) this materially understates total activity.',
  spillLowerBound:
    'The spill estimate is a lower bound: T-100 reports segment traffic summarized per airport, so it cannot see passengers recaptured on another flight, another day, or a nearby airport, and cannot attribute unmet demand to specific routes.',
  cohortRelative:
    'Scores are normalized within each airport FAA hub-class cohort, so they measure strength relative to comparable airports. The materiality multiplier then adjusts for absolute passenger volume.',
  noCostData:
    'No public data exists on construction cost, so this ranks relative expansion opportunity, not return on investment.',
};
