/**
 * Month-key arithmetic.
 *
 * Month keys are "YYYY-MM" strings: lexically sortable, JSON-safe, and free
 * of the timezone hazards that come with using Date for what is really just
 * a calendar label.
 */

export interface YearMonth {
  year: number;
  month: number;
}

const MonthKeyPattern = /^(?<year>\d{4})-(?<month>\d{2})$/;

export function ParseMonthKey(monthKey: string) {
  const match = MonthKeyPattern.exec(monthKey);
  if (!match?.groups) throw new Error(`Invalid month key: "${monthKey}" (expected YYYY-MM)`);

  const parsed: YearMonth = {
    year: Number(match.groups.year),
    month: Number(match.groups.month),
  };
  if (parsed.month < 1 || parsed.month > 12) throw new Error(`Invalid month in key: "${monthKey}"`);
  return parsed;
}

export function FormatMonthKey(yearMonth: YearMonth) {
  return `${yearMonth.year}-${String(yearMonth.month).padStart(2, '0')}`;
}

/** Inclusive at both ends. */
export function EnumerateMonths(fromKey: string, toKey: string) {
  const from = ParseMonthKey(fromKey);
  const to = ParseMonthKey(toKey);

  const months: YearMonth[] = [];
  let cursor: YearMonth = { ...from };

  while (cursor.year < to.year || (cursor.year === to.year && cursor.month <= to.month)) {
    months.push({ ...cursor });
    cursor = cursor.month === 12 ? { year: cursor.year + 1, month: 1 } : { year: cursor.year, month: cursor.month + 1 };
  }

  return months;
}

export function CountMonthsBetween(fromKey: string, toKey: string) {
  const from = ParseMonthKey(fromKey);
  const to = ParseMonthKey(toKey);
  return (to.year - from.year) * 12 + (to.month - from.month) + 1;
}

/** Shifts a month key by a signed number of months. */
export function ShiftMonthKey(monthKey: string, deltaMonths: number) {
  const parsed = ParseMonthKey(monthKey);
  const zeroBased = parsed.year * 12 + (parsed.month - 1) + deltaMonths;
  return FormatMonthKey({ year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 });
}
