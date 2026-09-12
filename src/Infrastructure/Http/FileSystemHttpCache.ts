import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CacheEntryMeta, IHttpCache } from '../../Types/Ports/Fetchers';
import type { IClock } from '../../Types/Ports/Clock';

/**
 * L1 cache: raw upstream responses on disk, keyed by URL hash.
 *
 * Purpose is twofold. A re-run of ingest does not re-download ~372MB of BTS
 * archives, and once primed the whole build works offline — which matters
 * when the demo is running on conference wifi.
 *
 * Bodies are stored as opaque bytes alongside a small JSON sidecar holding
 * the fetch time and TTL, so expiry does not require parsing the payload.
 */
export class FileSystemHttpCache implements IHttpCache {
  private readonly rootDirectory: string;
  private readonly clock: IClock;

  constructor(rootDirectory: string, clock: IClock) {
    this.rootDirectory = rootDirectory;
    this.clock = clock;
  }

  public async Read(url: string) {
    const isFresh = await this.IsFresh(url);
    if (!isFresh) return null;
    return readFile(this.ResolvePath(url));
  }

  public async Write(url: string, body: Buffer, ttlSeconds: number) {
    await this.EnsureDirectory();

    const bodyPath = this.ResolvePath(url);
    await writeFile(bodyPath, body);

    const meta: CacheEntryMeta = {
      url,
      fetchedAt: this.clock.NowIso(),
      ttlSeconds,
      sha256: createHash('sha256').update(body).digest('hex'),
      byteLength: body.byteLength,
    };
    await writeFile(this.MetaPath(url), JSON.stringify(meta, null, 2), 'utf8');
  }

  public ResolvePath(url: string) {
    return join(this.rootDirectory, `${this.KeyFor(url)}.bin`);
  }

  public async Has(url: string) {
    return this.IsFresh(url);
  }

  /**
   * Records metadata for a body that was streamed straight to disk rather
   * than passing through Write(). Streaming downloads skip the sha256 so a
   * 275MB archive never has to be re-read just to hash it.
   */
  public async WriteMetaForStreamedFile(url: string, ttlSeconds: number) {
    await this.EnsureDirectory();
    const bodyPath = this.ResolvePath(url);
    const stats = await stat(bodyPath);

    const meta: CacheEntryMeta = {
      url,
      fetchedAt: this.clock.NowIso(),
      ttlSeconds,
      sha256: '',
      byteLength: stats.size,
    };
    await writeFile(this.MetaPath(url), JSON.stringify(meta, null, 2), 'utf8');
  }

  public async EnsureDirectory() {
    await mkdir(this.rootDirectory, { recursive: true });
  }

  /** Removes a partial download so a failed fetch cannot be served as valid. */
  public async Invalidate(url: string) {
    const paths = [this.ResolvePath(url), this.MetaPath(url)];
    for (const path of paths) {
      if (existsSync(path)) await unlink(path);
    }
  }

  private async IsFresh(url: string) {
    const bodyPath = this.ResolvePath(url);
    const metaPath = this.MetaPath(url);
    if (!existsSync(bodyPath) || !existsSync(metaPath)) return false;

    const meta = await this.ReadMeta(metaPath);
    if (!meta) return false;
    if (meta.ttlSeconds <= 0) return false;

    const ageSeconds = (this.clock.Now().getTime() - new Date(meta.fetchedAt).getTime()) / 1000;
    return ageSeconds < meta.ttlSeconds;
  }

  private async ReadMeta(metaPath: string) {
    try {
      const raw = await readFile(metaPath, 'utf8');
      return JSON.parse(raw) as CacheEntryMeta;
    } catch {
      // A corrupt sidecar means "not cached", never a crash.
      return null;
    }
  }

  private MetaPath(url: string) {
    return join(this.rootDirectory, `${this.KeyFor(url)}.meta.json`);
  }

  private KeyFor(url: string) {
    return createHash('sha256').update(url).digest('hex').slice(0, 32);
  }
}
