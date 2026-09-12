import { describe, expect, it } from 'vitest';

import { BuildAirport, TestConfig } from '../Fixtures/ScoringFixtures';
import { ScaleAdjuster } from '../../src/Scoring/Scale/ScaleAdjuster';

/** Real figures from the snapshot, which is what motivated this adjuster. */
const BangorEnplanements = 250_000;
const BostonEnplanements = 21_105_980;

describe('ScaleAdjuster', () => {
  const adjuster = new ScaleAdjuster(TestConfig.scale);

  it('is a no-op when materiality is switched off', () => {
    const tiny = adjuster.Resolve(BuildAirport({ annualEnplanements: 1_000 }), 'none');
    const huge = adjuster.Resolve(BuildAirport({ annualEnplanements: 50_000_000 }), 'none');

    expect(tiny.multiplier).toBe(1);
    expect(huge.multiplier).toBe(1);
  });

  /**
   * The case this exists for. Cohort-relative scoring put Bangor above Boston
   * Logan as a terminal expansion candidate; materiality has to reverse that
   * without erasing Bangor from the ranking.
   */
  it('lifts a mega-hub above a strong small airport', () => {
    const bangor = adjuster.Resolve(BuildAirport({ annualEnplanements: BangorEnplanements }), 'moderate');
    const boston = adjuster.Resolve(BuildAirport({ annualEnplanements: BostonEnplanements }), 'moderate');

    expect(bangor.multiplier).toBeLessThan(1);
    expect(boston.multiplier).toBeGreaterThan(1);

    // Applied to the scores actually observed, Boston must come out ahead.
    expect(65.3 * boston.multiplier).toBeGreaterThan(71.7 * bangor.multiplier);
  });

  /**
   * Logarithmic, not linear. Boston carries roughly 84x Bangor's passengers;
   * if the multiplier ratio approached that, the ranking would become a
   * passenger-count league table and every pillar signal would be discarded.
   */
  it('scales logarithmically, so an 84x traffic gap is a modest score tilt', () => {
    const bangor = adjuster.Resolve(BuildAirport({ annualEnplanements: BangorEnplanements }), 'moderate');
    const boston = adjuster.Resolve(BuildAirport({ annualEnplanements: BostonEnplanements }), 'moderate');

    const trafficRatio = BostonEnplanements / BangorEnplanements;
    const multiplierRatio = boston.multiplier / bangor.multiplier;

    expect(trafficRatio).toBeGreaterThan(80);
    expect(multiplierRatio).toBeLessThan(1.5);
  });

  it('tilts harder under strong weighting than moderate', () => {
    const tiny = BuildAirport({ annualEnplanements: 50_000 });
    const huge = BuildAirport({ annualEnplanements: 40_000_000 });

    const moderateSpread =
      adjuster.Resolve(huge, 'moderate').multiplier - adjuster.Resolve(tiny, 'moderate').multiplier;
    const strongSpread =
      adjuster.Resolve(huge, 'strong').multiplier - adjuster.Resolve(tiny, 'strong').multiplier;

    expect(strongSpread).toBeGreaterThan(moderateSpread);
  });

  it('is monotonic in passenger volume', () => {
    const multipliers = [10_000, 100_000, 1_000_000, 10_000_000, 40_000_000].map(
      (enplanements) => adjuster.Resolve(BuildAirport({ annualEnplanements: enplanements }), 'moderate').multiplier,
    );

    for (let index = 1; index < multipliers.length; index += 1) {
      expect(multipliers[index]).toBeGreaterThan(multipliers[index - 1]);
    }
  });

  it('clamps outside the configured floor and ceiling', () => {
    const band = TestConfig.scale.bands.moderate;

    const belowFloor = adjuster.Resolve(BuildAirport({ annualEnplanements: 1 }), 'moderate');
    const aboveCeiling = adjuster.Resolve(BuildAirport({ annualEnplanements: 500_000_000 }), 'moderate');

    expect(belowFloor.multiplier).toBeCloseTo(band.min, 6);
    expect(aboveCeiling.multiplier).toBeCloseTo(band.max, 6);
  });

  it('never returns a non-finite multiplier for degenerate input', () => {
    for (const enplanements of [0, -100]) {
      const result = adjuster.Resolve(BuildAirport({ annualEnplanements: enplanements }), 'moderate');
      expect(Number.isFinite(result.multiplier)).toBe(true);
      expect(result.multiplier).toBeGreaterThan(0);
    }
  });

  it('explains which way it moved the score', () => {
    const small = adjuster.Resolve(BuildAirport({ annualEnplanements: BangorEnplanements }), 'moderate');
    const large = adjuster.Resolve(BuildAirport({ annualEnplanements: BostonEnplanements }), 'moderate');

    expect(small.narrative).toContain('Scaled down');
    expect(large.narrative).toContain('Scaled up');
  });
});
