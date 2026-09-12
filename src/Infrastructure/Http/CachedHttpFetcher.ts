import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { FetchOptions, IHttpFetcher } from '../../Types/Ports/Fetchers';
import type { ILogger } from '../../Types/Ports/Logger';
import type { FileSystemHttpCache } from './FileSystemHttpCache';

const DefaultTimeoutMs = 300_000;
const DefaultTtlSeconds = 60 * 60 * 24 * 7;

export class HttpRequestError extends Error {
  public readonly status: number;
  public readonly url: string;

  constructor(url: string, status: number, statusText: string) {
    super(`HTTP ${status} ${statusText} for ${url}`);
    this.name = 'HttpRequestError';
    this.status = status;
    this.url = url;
  }
}

/**
 * HTTP client with an on-disk response cache.
 *
 * The important method is FetchToFile: BTS On-Time Performance archives are
 * ~31MB compressed and ~275MB uncompressed per month, so they are streamed
 * straight to disk and read back as a stream. Nothing here ever materializes
 * a full archive in memory.
 */
export class CachedHttpFetcher implements IHttpFetcher {
  private readonly cache: FileSystemHttpCache;
  private readonly logger: ILogger;

  constructor(cache: FileSystemHttpCache, logger: ILogger) {
    this.cache = cache;
    this.logger = logger;
  }

  public async FetchJson<TResponse>(url: string, options: FetchOptions = {}) {
    const text = await this.FetchText(url, options);
    return JSON.parse(text) as TResponse;
  }

  public async FetchText(url: string, options: FetchOptions = {}) {
    const buffer = await this.FetchBuffer(url, options);
    return buffer.toString('utf8');
  }

  public async FetchBuffer(url: string, options: FetchOptions = {}) {
    const ttlSeconds = options.ttlSeconds ?? DefaultTtlSeconds;

    if (ttlSeconds > 0) {
      const cached = await this.cache.Read(url);
      if (cached) {
        this.logger.Debug('cache hit', { url });
        return cached;
      }
    }

    const response = await this.Request(url, options);
    const buffer = Buffer.from(await response.arrayBuffer());

    if (ttlSeconds > 0) await this.cache.Write(url, buffer, ttlSeconds);
    return buffer;
  }

  public async FetchStream(url: string, options: FetchOptions = {}) {
    const path = await this.FetchToFile(url, options);
    return createReadStream(path) as unknown as Readable;
  }

  /**
   * Downloads to the cache directory and returns the local path.
   *
   * On any failure the partial file is invalidated, so a truncated download
   * can never be served back as a valid cache entry on the next run.
   */
  public async FetchToFile(url: string, options: FetchOptions = {}) {
    const ttlSeconds = options.ttlSeconds ?? DefaultTtlSeconds;
    const destination = this.cache.ResolvePath(url);

    if (ttlSeconds > 0 && (await this.cache.Has(url))) {
      this.logger.Debug('cache hit (file)', { url });
      return destination;
    }

    await this.cache.EnsureDirectory();
    this.logger.Info('downloading', { url });

    try {
      const response = await this.Request(url, options);
      if (!response.body) throw new HttpRequestError(url, response.status, 'empty response body');

      const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      await pipeline(source, createWriteStream(destination));
      await this.cache.WriteMetaForStreamedFile(url, ttlSeconds);

      return destination;
    } catch (error) {
      await this.cache.Invalidate(url);
      throw error;
    }
  }

  private async Request(url: string, options: FetchOptions) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DefaultTimeoutMs);

    try {
      const response = await fetch(url, {
        headers: options.headers,
        signal: controller.signal,
      });
      if (!response.ok) throw new HttpRequestError(url, response.status, response.statusText);
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}
