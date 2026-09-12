/**
 * Logging port.
 *
 * NOTE ON PORTS: interfaces in this folder are the one place the project
 * declares explicit return types. An interface is nothing but its signature,
 * so contracts declare and implementations infer — TypeScript then verifies
 * that the inferred implementation conforms.
 */

export interface LogFields {
  [key: string]: unknown;
}

export interface ILogger {
  Debug(message: string, fields?: LogFields): void;
  Info(message: string, fields?: LogFields): void;
  Warn(message: string, fields?: LogFields): void;
  Error(message: string, fields?: LogFields): void;
  /** Progress reporting for long ingest loops. */
  Progress(message: string, current: number, total: number): void;
}
