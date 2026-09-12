import { describe, expect, it } from 'vitest';

import {
  CountMonthsBetween,
  EnumerateMonths,
  FormatMonthKey,
  ParseMonthKey,
  ShiftMonthKey,
} from '../../src/Infrastructure/Time/MonthSequence';

/**
 * Month keys drive every analysis window, so an off-by-one here would shift
 * the entire scoring period without any visible error.
 */
describe('MonthSequence', () => {
  it('round-trips a month key', () => {
    expect(FormatMonthKey(ParseMonthKey('2026-04'))).toBe('2026-04');
    expect(ParseMonthKey('2026-04')).toEqual({ year: 2026, month: 4 });
  });

  it('rejects malformed keys loudly', () => {
    for (const bad of ['2026-4', '202604', '2026-13', '2026-00', 'not-a-month', '']) {
      expect(() => ParseMonthKey(bad)).toThrow();
    }
  });

  it('enumerates inclusively at both ends', () => {
    const months = EnumerateMonths('2025-11', '2026-02');
    expect(months.map(FormatMonthKey)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('enumerates a single month', () => {
    expect(EnumerateMonths('2026-06', '2026-06').map(FormatMonthKey)).toEqual(['2026-06']);
  });

  it('returns nothing when the range is inverted', () => {
    expect(EnumerateMonths('2026-06', '2026-01')).toHaveLength(0);
  });

  it('produces exactly twelve months for the default ingest window', () => {
    const months = EnumerateMonths('2025-07', '2026-06');
    expect(months).toHaveLength(12);
    expect(CountMonthsBetween('2025-07', '2026-06')).toBe(12);
  });

  it('shifts across year boundaries in both directions', () => {
    expect(ShiftMonthKey('2026-01', -1)).toBe('2025-12');
    expect(ShiftMonthKey('2025-12', 1)).toBe('2026-01');
    expect(ShiftMonthKey('2026-04', -11)).toBe('2025-05');
    expect(ShiftMonthKey('2026-04', -36)).toBe('2023-04');
    expect(ShiftMonthKey('2026-04', 0)).toBe('2026-04');
  });

  it('keeps shifting reversible', () => {
    for (const delta of [1, 7, 12, 36, -5, -24]) {
      expect(ShiftMonthKey(ShiftMonthKey('2026-04', delta), -delta)).toBe('2026-04');
    }
  });

  /**
   * Month keys are compared lexically throughout the SQL layer, so string
   * ordering must match chronological ordering.
   */
  it('sorts lexically in chronological order', () => {
    const shuffled = ['2026-01', '2025-12', '2026-10', '2026-02', '2025-07'];
    expect([...shuffled].sort()).toEqual(['2025-07', '2025-12', '2026-01', '2026-02', '2026-10']);
  });
});
