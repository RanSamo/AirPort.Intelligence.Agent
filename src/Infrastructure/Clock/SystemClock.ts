import type { IClock } from '../../Types/Ports/Clock';

export class SystemClock implements IClock {
  public Now() {
    return new Date();
  }

  public NowIso() {
    return new Date().toISOString();
  }

  public EpochSeconds() {
    return Math.floor(Date.now() / 1000);
  }
}

/**
 * Deterministic clock for tests. Lets snapshot timestamps and cache expiry
 * be asserted exactly instead of approximately.
 */
export class FixedClock implements IClock {
  private current: Date;

  constructor(initial: Date) {
    this.current = initial;
  }

  public Now() {
    return this.current;
  }

  public NowIso() {
    return this.current.toISOString();
  }

  public EpochSeconds() {
    return Math.floor(this.current.getTime() / 1000);
  }

  public Advance(seconds: number) {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}
