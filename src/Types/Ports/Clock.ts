/**
 * Clock port.
 *
 * Injected rather than calling Date.now() directly so that snapshot
 * timestamps and cache expiry are deterministic under test.
 */
export interface IClock {
  Now(): Date;
  NowIso(): string;
  EpochSeconds(): number;
}
