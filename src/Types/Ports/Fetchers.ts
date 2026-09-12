import type { Readable } from 'node:stream';

/**
 * HTTP and caching ports.
 *
 * The L1 cache stores raw upstream responses on disk keyed by URL hash, so
 * a re-run of ingest does not re-download ~372MB, and so the whole build
 * works offline once primed.
 */

export interface CacheEntryMeta {
  url: string;
  fetchedAt: string;
  /** Seconds. */
  ttlSeconds: number;
  sha256: string;
  byteLength: number;
}

export interface IHttpCache {
  /** Returns the cached body, or null when absent or expired. */
  Read(url: string): Promise<Buffer | null>;
  Write(url: string, body: Buffer, ttlSeconds: number): Promise<void>;
  /** Absolute path of the cached file, downloading via the fetcher if needed. */
  ResolvePath(url: string): string;
  Has(url: string): Promise<boolean>;
}

export interface FetchOptions {
  /** Cache lifetime. 0 disables caching for this request. */
  ttlSeconds?: number;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface IHttpFetcher {
  FetchJson<TResponse>(url: string, options?: FetchOptions): Promise<TResponse>;
  FetchText(url: string, options?: FetchOptions): Promise<string>;
  FetchBuffer(url: string, options?: FetchOptions): Promise<Buffer>;
  /**
   * Downloads to the on-disk cache and returns a read stream over it.
   * Used for the ~275MB-per-month OTP archives, which must never be
   * materialized in memory.
   */
  FetchStream(url: string, options?: FetchOptions): Promise<Readable>;
  /** Local path of the cached download, fetching first if necessary. */
  FetchToFile(url: string, options?: FetchOptions): Promise<string>;
}
