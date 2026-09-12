import type { ILogger, LogFields } from '../../Types/Ports/Logger';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

interface LevelRanks {
  [level: string]: number;
}

const levelRanks: LevelRanks = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

export class ConsoleLogger implements ILogger {
  private readonly minimumRank: number;
  private lastProgressLength = 0;

  constructor(level: LogLevel = 'info') {
    this.minimumRank = levelRanks[level] ?? levelRanks.info;
  }

  public Debug(message: string, fields?: LogFields) {
    this.Write('debug', message, fields);
  }

  public Info(message: string, fields?: LogFields) {
    this.Write('info', message, fields);
  }

  public Warn(message: string, fields?: LogFields) {
    this.Write('warn', message, fields);
  }

  public Error(message: string, fields?: LogFields) {
    this.Write('error', message, fields);
  }

  /**
   * Single-line progress that overwrites itself, so a 12-month ingest does
   * not produce thousands of scroll lines. Falls back to plain lines when
   * stdout is not a TTY (CI, piped output).
   */
  public Progress(message: string, current: number, total: number) {
    if (levelRanks.info < this.minimumRank) return;

    const percent = total > 0 ? Math.floor((current / total) * 100) : 0;
    const line = `  ${message} ${current}/${total} (${percent}%)`;

    if (!process.stdout.isTTY) {
      if (current === total) process.stdout.write(`${line}\n`);
      return;
    }

    const padding = ' '.repeat(Math.max(0, this.lastProgressLength - line.length));
    process.stdout.write(`\r${line}${padding}`);
    this.lastProgressLength = line.length;

    if (current === total) {
      process.stdout.write('\n');
      this.lastProgressLength = 0;
    }
  }

  private Write(level: LogLevel, message: string, fields?: LogFields) {
    if ((levelRanks[level] ?? 0) < this.minimumRank) return;

    this.ClearProgressLine();

    const prefix = `[${level.toUpperCase()}]`.padEnd(7);
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
    const line = `${prefix} ${message}${suffix}`;

    if (level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  /** Prevents a half-written progress line from being mangled by a log line. */
  private ClearProgressLine() {
    if (this.lastProgressLength === 0 || !process.stdout.isTTY) return;
    process.stdout.write(`\r${' '.repeat(this.lastProgressLength)}\r`);
    this.lastProgressLength = 0;
  }
}
