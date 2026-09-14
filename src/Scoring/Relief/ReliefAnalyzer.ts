import { MetricsById } from '../../Metrics/MetricRegistry';
import type { Airport } from '../../Types/Domain/Airport';
import type { IAirportRepository, IFacilityRepository, IMetricRepository } from '../../Types/Ports/Repositories';
import type { MetricValuesByMetricAndAirport } from '../../Types/Domain/Metric';
import type {
  PrimaryConstraintProfile,
  ReliefAssessment,
  ReliefCandidate,
  ReliefEvidence,
} from '../../Types/Scoring/Relief';
import type { ScoringEngine } from '../ScoringEngine';

/**
 * Finds airports that could absorb overflow from a constrained one.
 *
 * Encodes the secondary-airport thesis: when capacity at a mega-hub is
 * expensive or unobtainable, the investable asset may be the neighbour that
 * catches the spill. Ontario rather than Los Angeles.
 *
 * Two conditions must both hold. The primary has to be genuinely constrained
 * (otherwise there is no overflow to catch), and the neighbour has to have
 * real headroom - seats, airfield capacity, and no regulatory ceiling.
 *
 * DELIBERATE LIMIT: this measures physical and regulatory headroom, not
 * whether passengers would actually travel to the alternative. That depends
 * on ground access and catchment overlap, which no free source covers. The
 * assessment says so rather than implying a demand forecast.
 */

/** Load factor above which an airport is treated as seat-constrained. */
const ConstrainedLoadFactor = 0.82;
/** Taxi-out p90 above which an airport is treated as airfield-constrained. */
const ConstrainedTaxiOutP90 = 30;
/** Headroom below which a candidate relieves nothing. */
const ViableHeadroomFloor = 40;
const DefaultRadiusKm = 150;

const EarthRadiusKm = 6371;

export class ReliefAnalyzer {
  private readonly airports: IAirportRepository;
  private readonly metrics: IMetricRepository;
  private readonly facilities: IFacilityRepository;
  private readonly engine: ScoringEngine;

  constructor(
    airports: IAirportRepository,
    metrics: IMetricRepository,
    facilities: IFacilityRepository,
    engine: ScoringEngine,
  ) {
    this.airports = airports;
    this.metrics = metrics;
    this.facilities = facilities;
    this.engine = engine;
  }

  /** Returns null when the primary airport cannot be resolved. */
  public Assess(primaryCode: string, periodId: string, radiusKm = DefaultRadiusKm) {
    const primary = this.airports.GetByCode(primaryCode);
    if (!primary) return null;

    const neighbours = this.airports
      .FindWithinRadius(primary.latitude, primary.longitude, radiusKm)
      .filter((airport) => airport.iata !== primary.iata);

    const codes = [primary.iata, ...neighbours.map((airport) => airport.iata)];
    const values = this.metrics.GetForAirports(
      codes,
      ['avg_load_factor', 'spill_rate', 'taxi_out_p90', 'enplanement_cagr_3y'],
      periodId,
    );

    const scores = this.engine.ScoreUniverse(periodId, {});
    const primaryProfile = this.BuildPrimaryProfile(primary, values);

    const candidates = neighbours
      .map((airport) => this.BuildCandidate(airport, primary, values, scores[airport.iata]?.score ?? null))
      .sort((left, right) => right.headroomScore - left.headroomScore);

    const assessment: ReliefAssessment = {
      primary: primaryProfile,
      radiusKm,
      candidates,
      narrative: this.Narrate(primaryProfile, candidates),
      caveats: [
        'Headroom is physical and regulatory capacity only. Whether passengers would actually use the alternative depends on ground access and catchment overlap, which no free public source covers.',
        'Distances are straight-line, not drive time. A 60 km airport across a congested metro may be less accessible than one twice as far on open road.',
      ],
    };
    return assessment;
  }

  private BuildPrimaryProfile(primary: Airport, values: MetricValuesByMetricAndAirport) {
    const loadFactor = this.Read(values, 'avg_load_factor', primary.iata);
    const spillRate = this.Read(values, 'spill_rate', primary.iata);
    const taxiOutP90 = this.Read(values, 'taxi_out_p90', primary.iata);

    const seatConstrained = loadFactor !== null && loadFactor >= ConstrainedLoadFactor;
    const airfieldConstrained = taxiOutP90 !== null && taxiOutP90 >= ConstrainedTaxiOutP90;
    const isConstrained = seatConstrained || airfieldConstrained;

    const reasons: string[] = [];
    if (seatConstrained) reasons.push(`aircraft run ${((loadFactor ?? 0) * 100).toFixed(1)}% full`);
    if (airfieldConstrained) reasons.push(`taxi-out reaches ${(taxiOutP90 ?? 0).toFixed(0)} minutes at the 90th percentile`);

    const profile: PrimaryConstraintProfile = {
      iata: primary.iata,
      name: primary.name,
      loadFactor,
      spillRate,
      taxiOutP90,
      isConstrained,
      narrative: isConstrained
        ? `${primary.name} is constrained: ${reasons.join(' and ')}.`
        : `${primary.name} is not showing strong capacity pressure, so overflow to a secondary airport is a weaker thesis here.`,
    };
    return profile;
  }

  private BuildCandidate(
    airport: Airport,
    primary: Airport,
    values: MetricValuesByMetricAndAirport,
    expansionScore: number | null,
  ) {
    const loadFactor = this.Read(values, 'avg_load_factor', airport.iata);
    const spillRate = this.Read(values, 'spill_rate', airport.iata);
    const taxiOutP90 = this.Read(values, 'taxi_out_p90', airport.iata);
    const growth = this.Read(values, 'enplanement_cagr_3y', airport.iata);

    const facility = this.facilities.GetByCode(airport.iata);
    const evidence: ReliefEvidence[] = [];

    // Headroom starts neutral and moves on evidence, so an airport with no
    // data lands in the middle rather than being scored as if it were empty.
    let headroom = 50;

    if (loadFactor !== null) {
      const slack = ConstrainedLoadFactor - loadFactor;
      headroom += slack * 150;
      if (slack > 0.03) {
        evidence.push({
          signal: 'seat_headroom',
          narrative: `Aircraft run ${(loadFactor * 100).toFixed(1)}% full, leaving room to carry more passengers on flights that already operate.`,
        });
      } else {
        evidence.push({
          signal: 'no_headroom',
          narrative: `At ${(loadFactor * 100).toFixed(1)}% load factor this airport is nearly as full as ${primary.iata}, so it cannot absorb much.`,
        });
      }
    }

    if (taxiOutP90 !== null) {
      const slack = ConstrainedTaxiOutP90 - taxiOutP90;
      headroom += Math.max(-15, Math.min(15, slack));
      if (slack > 5) {
        evidence.push({
          signal: 'airfield_headroom',
          narrative: `Taxi-out reaches only ${taxiOutP90.toFixed(0)} minutes at the 90th percentile, so the airfield can take more movements.`,
        });
      }
    }

    if (growth !== null && growth > 0.05) {
      headroom += 5;
      evidence.push({
        signal: 'already_absorbing',
        narrative: `Passengers have grown ${(growth * 100).toFixed(1)}% a year, evidence that carriers are already shifting capacity here.`,
      });
    }

    // A regulatory ceiling caps relief regardless of physical room: Long
    // Beach has a noise ordinance limiting air-carrier slots, so its empty
    // seats cannot simply be filled.
    if (facility?.feasibility.slotControlled || facility?.feasibility.landConstrained) {
      headroom -= 20;
      evidence.push({
        signal: 'regulatory_ceiling',
        narrative: facility.feasibility.slotControlled
          ? 'Slot-controlled, so added demand cannot simply be met with more flights.'
          : 'Physically constrained, which limits how much additional traffic it could take.',
      });
    }

    const headroomScore = Math.max(0, Math.min(100, headroom));

    const candidate: ReliefCandidate = {
      iata: airport.iata,
      name: airport.name,
      hubClass: airport.hubClass,
      distanceKm: Math.round(this.DistanceKm(primary, airport)),
      annualPassengers: airport.annualEnplanements,
      headroomScore: Number(headroomScore.toFixed(1)),
      loadFactor,
      spillRate,
      taxiOutP90,
      expansionScore: expansionScore === null ? null : Number(expansionScore.toFixed(1)),
      evidence,
      isViable: headroomScore >= ViableHeadroomFloor,
    };
    return candidate;
  }

  private Narrate(primary: PrimaryConstraintProfile, candidates: ReliefCandidate[]) {
    if (candidates.length === 0) {
      return `No other commercial airports were found near ${primary.name}, so there is no secondary-airport option in this market.`;
    }

    const viable = candidates.filter((candidate) => candidate.isViable);
    if (viable.length === 0) {
      return `${primary.narrative} None of the ${candidates.length} nearby airports has meaningful headroom, so overflow has nowhere obvious to go.`;
    }

    const best = viable[0];
    return (
      `${primary.narrative} ${best.name} (${best.iata}) has the most headroom of ${candidates.length} nearby airports, ` +
      `${best.distanceKm} km away.`
    );
  }

  private Read(values: MetricValuesByMetricAndAirport, metricId: string, iata: string) {
    const value = values[metricId]?.[iata];
    return value === undefined ? null : value;
  }

  private DistanceKm(from: Airport, to: Airport) {
    const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
    const deltaLat = toRadians(to.latitude - from.latitude);
    const deltaLon = toRadians(to.longitude - from.longitude);
    const a =
      Math.sin(deltaLat / 2) ** 2 +
      Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(deltaLon / 2) ** 2;
    return 2 * EarthRadiusKm * Math.asin(Math.sqrt(a));
  }
}

export { MetricsById };
