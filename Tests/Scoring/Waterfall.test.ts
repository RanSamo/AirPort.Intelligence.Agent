import { describe, expect, it } from 'vitest';

import { ScoreBaseline, WaterfallBuilder } from '../../src/Scoring/Explain/WaterfallBuilder';
import type { PillarScore, ScoredPillarId } from '../../src/Types/Scoring/Pillar';
import type { WaterfallInputs } from '../../src/Scoring/Explain/WaterfallBuilder';

function BuildPillar(pillarId: ScoredPillarId, score: number): PillarScore {
  return {
    pillarId,
    score,
    coverage: {
      ratio: 1,
      availableMetrics: ['taxi_out_p50'],
      missingMetrics: [],
      confidence: 'high',
    },
    contributions: [
      {
        metricId: 'taxi_out_p50',
        rawValue: 20,
        normalizedScore: score,
        effectiveWeight: 1,
        contribution: score,
      },
    ],
  };
}

function BuildInputs(overrides: Partial<WaterfallInputs> = {}): WaterfallInputs {
  return {
    pillars: {
      constraint: BuildPillar('constraint', 70),
      latentDemand: BuildPillar('latent_demand', 60),
      monetization: BuildPillar('monetization', 40),
    },
    needConstraintWeight: 0.55,
    needLatentDemandWeight: 0.45,
    needExponent: 0.65,
    payoffExponent: 0.35,
    aggregatedRaw: 58,
    feasibilityMultiplier: 1,
    feasibilityReasons: [],
    scaleMultiplier: 1,
    scaleNarrative: 'neutral',
    finalScore: 58,
    ...overrides,
  };
}

describe('WaterfallBuilder', () => {
  const builder = new WaterfallBuilder();

  /**
   * The central invariant of the explanation. Every term is constructed so
   * that the terms sum to the final score exactly — this is a real additive
   * attribution, not an approximation of one. If this ever drifts, the agent
   * would be narrating an explanation that does not add up to the number it
   * is explaining.
   */
  it('sums exactly to the final score', () => {
    const cases: WaterfallInputs[] = [
      BuildInputs(),
      BuildInputs({ aggregatedRaw: 58, feasibilityMultiplier: 0.8, finalScore: 58 * 0.8 }),
      BuildInputs({ aggregatedRaw: 58, scaleMultiplier: 1.15, finalScore: 58 * 1.15 }),
      BuildInputs({
        aggregatedRaw: 58,
        feasibilityMultiplier: 0.76,
        scaleMultiplier: 1.1,
        finalScore: 58 * 0.76 * 1.1,
      }),
    ];

    for (const inputs of cases) {
      const waterfall = builder.Build(inputs);
      const summed = waterfall.terms.reduce((total, term) => total + term.amount, 0);

      expect(summed).toBeCloseTo(inputs.finalScore, 6);
      expect(waterfall.total).toBeCloseTo(inputs.finalScore, 6);
    }
  });

  it('starts from the cohort median', () => {
    const waterfall = builder.Build(BuildInputs());
    expect(waterfall.baseline).toBe(ScoreBaseline);
    expect(waterfall.terms[0].kind).toBe('baseline');
    expect(waterfall.terms[0].amount).toBe(ScoreBaseline);
  });

  it('keeps the running total consistent with the terms', () => {
    const waterfall = builder.Build(
      BuildInputs({ feasibilityMultiplier: 0.8, scaleMultiplier: 1.1, finalScore: 58 * 0.8 * 1.1 }),
    );

    let running = 0;
    for (const term of waterfall.terms) {
      running += term.amount;
      expect(term.runningTotal).toBeCloseTo(running, 6);
    }
  });

  /**
   * The geometric penalty must be visible rather than silently folded into a
   * pillar, because "you were punished for being unbalanced" is exactly the
   * reasoning a user needs to see.
   */
  it('surfaces the geometric balance penalty as its own term', () => {
    const waterfall = builder.Build(BuildInputs({ aggregatedRaw: 52, finalScore: 52 }));
    const balanceTerm = waterfall.terms.find((term) => term.label === 'Balance across pillars');

    expect(balanceTerm).toBeDefined();
    expect(balanceTerm!.amount).toBeLessThan(0);
    expect(balanceTerm!.narrative).toContain('uneven');
  });

  it('reports feasibility and materiality separately', () => {
    const waterfall = builder.Build(
      BuildInputs({
        feasibilityMultiplier: 0.8,
        feasibilityReasons: ['FAA slot-controlled'],
        scaleMultiplier: 1.15,
        scaleNarrative: 'Scaled up for materiality',
        finalScore: 58 * 0.8 * 1.15,
      }),
    );

    const feasibility = waterfall.terms.find((term) => term.kind === 'feasibility');
    const scale = waterfall.terms.find((term) => term.kind === 'scale');

    expect(feasibility?.amount).toBeLessThan(0);
    expect(feasibility?.narrative).toContain('slot-controlled');
    expect(scale?.amount).toBeGreaterThan(0);
  });

  it('omits multiplier terms that did nothing', () => {
    const waterfall = builder.Build(BuildInputs({ feasibilityMultiplier: 1, scaleMultiplier: 1 }));
    expect(waterfall.terms.some((term) => term.kind === 'feasibility')).toBe(false);
    expect(waterfall.terms.some((term) => term.kind === 'scale')).toBe(false);
  });

  it('explains a pillar that had no usable data', () => {
    const empty = BuildPillar('constraint', 50);
    empty.contributions = [];

    const waterfall = builder.Build(
      BuildInputs({
        pillars: {
          constraint: empty,
          latentDemand: BuildPillar('latent_demand', 60),
          monetization: BuildPillar('monetization', 40),
        },
      }),
    );

    const constraintTerm = waterfall.terms.find((term) => term.label === 'Capacity pressure');
    expect(constraintTerm?.narrative).toContain('No usable');
  });
});
