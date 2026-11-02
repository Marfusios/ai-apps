import { Parser } from 'htmlparser2';
import { createHash, randomUUID } from 'node:crypto';
import { open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ImportFailure,
  SOURCE_CUTOFF,
  REMOTE_REFRESH_MS,
  type SourceObservation,
} from './contracts.js';
import { ManagedSpace, fileDigest, privateDirectory } from './files.js';

export const LISTING_URL = 'https://data.ntsb.gov/avdata/';
export const ARCHIVE_URL =
  'https://data.ntsb.gov/avdata/FileDirectory/DownloadFile?fileID=avall.zip';
export const MAX_ARCHIVE_BYTES = 200 * 1024 ** 2;
export function parseSourceDate(value: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/.exec(value.trim());
  if (!m) throw new ImportFailure('source_listing_changed');
  const [, mo, day, year, h, minute, second, ampm] = m;
  const hour = (Number(h) % 12) + (ampm === 'PM' ? 12 : 0);
  const date = `${year}-${mo!.padStart(2, '0')}-${day!.padStart(2, '0')}T${String(hour).padStart(2, '0')}:${minute}:${second}`;
  if (
    Number(h) < 1 ||
    Number(h) > 12 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    !Number.isFinite(Date.parse(`${date}Z`)) ||
    new Date(`${date}Z`).toISOString().slice(0, 19) !== date
  )
    throw new ImportFailure('source_listing_changed');
  return date;
}
export function parseListing(html: string): SourceObservation {
  if (Buffer.byteLength(html) > 2 * 1024 ** 2) throw new ImportFailure('source_listing_changed');
  let row: { text: string[]; links: string[] } | null = null,
    cell = '',
    depth = 0;
  const rows: { text: string[]; links: string[] }[] = [];
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === 'tr') {
          if (row) throw new ImportFailure('source_listing_changed');
          row = { text: [], links: [] };
        }
        if (row && (name === 'td' || name === 'th')) {
          depth++;
          cell = '';
        }
        if (row && name === 'a' && attrs.href) row.links.push(attrs.href);
      },
      ontext(text) {
        if (row && depth) cell += text;
      },
      onclosetag(name) {
        if (row && (name === 'td' || name === 'th')) {
          row.text.push(cell.trim());
          depth--;
        }
        if (name === 'tr' && row) {
          rows.push(row);
          row = null;
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  const matches = rows.filter((r) => r.text[0] === 'avall.zip');
  if (matches.length !== 1) throw new ImportFailure('source_listing_changed');
  const r = matches[0]!;
  if (
    r.text.length !== 4 ||
    r.links.length !== 1 ||
    r.links[0] !== '/avdata/FileDirectory/DownloadFile?fileID=avall.zip' ||
    !/^\d+$/.test(r.text[2]!)
  )
    throw new ImportFailure('source_listing_changed');
  const bytes = Number(r.text[2]);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_ARCHIVE_BYTES)
    throw new ImportFailure('source_listing_changed');
  return { advertisedAtLocal: parseSourceDate(r.text[1]!), bytes };
}
export function refreshOwed(lastRemoteFetchAt: string | null, now: Date): boolean {
  return (
    lastRemoteFetchAt === null ||
    !Number.isFinite(Date.parse(lastRemoteFetchAt)) ||
    now.getTime() - Date.parse(lastRemoteFetchAt) >= REMOTE_REFRESH_MS
  );
}
export function sameObservation(a: SourceObservation, b: SourceObservation): boolean {
  return a.bytes === b.bytes && a.advertisedAtLocal === b.advertisedAtLocal;
}
export interface HttpAdapter {
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): Date;
  random?(): number;
}
/** Source acquisition boundary. A future source needs a separately reviewed snapshot/provenance contract. */
export interface SnapshotSource {
  readonly id: string;
  inspect(): Promise<SourceObservation>;
  acquire(
    observation: SourceObservation,
    space: ManagedSpace,
  ): Promise<{ path: string; sha256: string; fetchedAt: string }>;
}
export const DEFAULT_HTTP: HttpAdapter = {
  fetch: globalThis.fetch,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
};

async function response(
  url: string,
  totalMs: number,
  fn: (r: Response, signal: AbortSignal) => Promise<void>,
  http: HttpAdapter,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    // Retry-After/backoff can cross the retirement instant after the outer check.
    if (http.now().getTime() >= SOURCE_CUTOFF) throw new ImportFailure('source_retired');
    const controller = new AbortController();
    const headerTimer = setTimeout(() => controller.abort(), 10_000),
      totalTimer = setTimeout(() => controller.abort(), totalMs);
    let retry = false,
      delay = 1000 * 2 ** attempt;
    try {
      const r = await http.fetch(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'Accept-Encoding': 'identity',
          'User-Agent': 'AirCase-snapshot-importer/1.0',
        },
      });
      clearTimeout(headerTimer);
      if (r.status === 408 || r.status === 429 || r.status >= 500) {
        const after = r.headers.get('retry-after');
        if (after)
          delay = /^\d+$/.test(after)
            ? Number(after) * 1000
            : Date.parse(after) - http.now().getTime();
        await r.body?.cancel();
        if (!Number.isFinite(delay) || delay > 60_000)
          throw new ImportFailure('source_unavailable');
        retry = true;
      } else {
        if (r.status !== 200) {
          await r.body?.cancel();
          throw new ImportFailure('source_unavailable');
        }
        if ((r.headers.get('content-encoding') ?? 'identity') !== 'identity') {
          await r.body?.cancel();
          throw new ImportFailure('source_listing_changed');
        }
        await fn(r, controller.signal);
        return;
      }
    } catch (e) {
      if (e instanceof ImportFailure) throw e;
      retry = true;
    } finally {
      clearTimeout(headerTimer);
      clearTimeout(totalTimer);
      controller.abort();
    }
    if (!retry || attempt === 2) throw new ImportFailure('source_unavailable');
    const jitter = Math.floor((http.random ?? Math.random)() * 1000);
    await http.sleep(Math.min(60_000, Math.max(100, delay) + jitter));
  }
}
async function stream(
  r: Response,
  limit: number,
  signal: AbortSignal,
  write: (bytes: Uint8Array) => Promise<void>,
): Promise<number> {
  if (!r.body) throw new ImportFailure('integrity');
  const reader = r.body.getReader();
  let count = 0;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ImportFailure('source_unavailable')), 30_000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (signal.aborted) throw new ImportFailure('source_unavailable');
      if (next.done) return count;
      count += next.value.length;
      if (count > limit) throw new ImportFailure('integrity');
      await write(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export class AvallSource implements SnapshotSource {
  readonly id = 'ntsb-avall.v1';
  constructor(readonly http = DEFAULT_HTTP) {}
  async inspect(): Promise<SourceObservation> {
    if (this.http.now().getTime() >= SOURCE_CUTOFF) throw new ImportFailure('source_retired');
    let html = '';
    await response(
      LISTING_URL,
      30_000,
      async (r, signal) => {
        const chunks: Uint8Array[] = [];
        await stream(r, 2 * 1024 ** 2, signal, async (b) => {
          chunks.push(b);
        });
        try {
          html = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        } catch {
          throw new ImportFailure('integrity');
        }
      },
      this.http,
    );
    return parseListing(html);
  }
  async acquire(
    observation: SourceObservation,
    space: ManagedSpace,
  ): Promise<{ path: string; sha256: string; fetchedAt: string }> {
    if (this.http.now().getTime() >= SOURCE_CUTOFF) throw new ImportFailure('source_retired');
    await privateDirectory(join(space.root, 'archives'));
    let sha256 = '',
      result = '';
    await response(
      ARCHIVE_URL,
      600_000,
      async (r, signal) => {
        if (/text\/html/i.test(r.headers.get('content-type') ?? ''))
          throw new ImportFailure('integrity');
        const part = `archives/${randomUUID()}.part`;
        await space.register(part);
        const temp = join(space.root, part),
          hash = createHash('sha256');
        try {
          const h = await open(temp, 'wx', 0o600);
          try {
            const bytes = await stream(
              r,
              Math.min(observation.bytes, MAX_ARCHIVE_BYTES),
              signal,
              async (b) => {
                await space.check(b.length);
                hash.update(b);
                await h.writeFile(b);
              },
            );
            const length = r.headers.get('content-length');
            if (
              bytes !== observation.bytes ||
              (length !== null && (!/^\d+$/.test(length) || Number(length) !== bytes))
            )
              throw new ImportFailure('integrity');
            await h.sync();
            sha256 = hash.digest('hex');
          } finally {
            await h.close();
          }
          const after = await this.inspect();
          if (!sameObservation(observation, after)) {
            await space.remove(temp);
            throw new ImportFailure('source_changed_during_download');
          }
          await space.register(`archives/${sha256}`);
          const dir = join(space.root, 'archives', sha256);
          await privateDirectory(dir);
          result = join(dir, 'avall.zip');
          try {
            if ((await fileDigest(result)) !== sha256) throw new ImportFailure('integrity');
            await space.remove(temp);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            await rename(temp, result);
            await space.remove(temp);
          }
          if ((await fileDigest(result)) !== sha256) throw new ImportFailure('integrity');
          await space.json(join(dir, 'manifest.json'), {
            sha256,
            bytes: observation.bytes,
            observation,
            fetchedAt: this.http.now().toISOString(),
          });
        } catch (e) {
          await space.remove(temp);
          if ((e as NodeJS.ErrnoException).code === 'ENOSPC') throw new ImportFailure('storage');
          throw e;
        }
      },
      this.http,
    );
    return { path: result, sha256, fetchedAt: this.http.now().toISOString() };
  }
}
