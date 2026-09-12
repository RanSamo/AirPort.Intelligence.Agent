/**
 * Time periods.
 *
 * The snapshot stores facts at month grain. Metrics are computed over a
 * window of months so that seasonality does not distort a score.
 */

/** Calendar month, ISO-like and lexically sortable: "2026-04". */
export type MonthKey = string;

/** Calendar year as a string: "2025". */
export type YearKey = string;

export interface MonthRange {
  /** Inclusive. */
  from: MonthKey;
  /** Inclusive. */
  to: MonthKey;
}

/**
 * A named analysis window. Metrics always carry the window they were
 * computed over so the agent can state it in every answer.
 */
export interface AnalysisPeriod {
  id: string;
  label: string;
  range: MonthRange;
  monthCount: number;
}

export interface MonthlyValues {
  [monthKey: string]: number;
}
