import { parse } from 'csv-parse';
import type { Readable } from 'node:stream';

/** A parsed CSV row, keyed by column header. */
export interface CsvRow {
  [column: string]: string;
}

export interface CsvParseOptions {
  /** Drop rows whose column count differs from the header instead of throwing. */
  tolerateInconsistentColumns?: boolean;
}

/**
 * Streams a CSV as header-keyed rows.
 *
 * Rows are yielded one at a time and never accumulated, so a 275MB / 600k-row
 * BTS archive is processed in constant memory. Callers aggregate into
 * counters and discard each row immediately.
 *
 * Columns are keyed by header name rather than position — a positional read
 * would silently produce wrong numbers if BTS ever reorders its 110 columns.
 */
export class CsvStreamParser {
  public async *Rows(source: Readable, options: CsvParseOptions = {}) {
    const parser = parse({
      columns: true,
      bom: true,
      skipEmptyLines: true,
      relaxColumnCount: options.tolerateInconsistentColumns ?? true,
      trim: true,
    });

    const stream = source.pipe(parser);
    for await (const row of stream) {
      yield row as CsvRow;
    }
  }
}

/** Parses a numeric CSV cell, returning 0 for blanks and malformed values. */
export function ParseNumber(raw: string | undefined) {
  if (raw === undefined || raw === '') return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Parses a numeric CSV cell, returning null for blanks so "absent" stays distinguishable from zero. */
export function ParseOptionalNumber(raw: string | undefined) {
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
