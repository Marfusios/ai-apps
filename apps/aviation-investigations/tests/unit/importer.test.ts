import { beforeAll, describe, expect, it } from 'vitest';
import { readProjectedTables, type RawTables } from '../../worker/ingest/normalize.js';
import { TABLE_NAMES } from '../../worker/ingest/tables.js';
import { sourceFacts, digest } from '../../worker/importer/provenance.js';
import { compareSnapshots } from '../../worker/importer/compare.js';
import { parseListing, refreshOwed, AvallSource } from '../../worker/importer/source.js';
import {
  SOURCE_CUTOFF,
  ImportFailure,
  safeFailure,
  safeLog,
  sameManifest,
} from '../../worker/importer/contracts.js';
import { nextCheck, inBackupWindow } from '../../worker/importer/status.js';
import {
  strictSearch,
  strictShards,
  certificationClient,
} from '../../worker/importer/strict-es.js';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedSpace, fileDigest } from '../../worker/importer/files.js';
import type { Client } from '@elastic/elasticsearch';
import { CONSUMED_CODES } from '../../worker/importer/codes.js';
import { candidateSample } from '../../worker/importer/probes.js';

type Rows = Record<string, Record<string, string>[]>;
let fixture: Rows;
beforeAll(async () => {
  fixture = (await readProjectedTables('fixtures/ntsb')) as unknown as Rows;
});
function corpus(n = 1000): RawTables {
  const seed = fixture.events!.find((r) => r.ntsb_no === 'DFW08TA066')!;
  const out: Rows = Object.fromEntries(TABLE_NAMES.map((t) => [t, []]));
  for (let i = 0; i < n; i++)
    for (const table of TABLE_NAMES) {
      for (const row of (fixture[table] ?? []).filter((r) => r.ev_id === seed.ev_id)) {
        out[table]!.push({
          ...row,
          ev_id: `EV${i}`,
          ...('ntsb_no' in row ? { ntsb_no: `SYN${i}` } : {}),
          ...('lchg_date' in row ? { lchg_date: '2026-09-30T00:00:00' } : {}),
        });
      }
    }
  return out as unknown as RawTables;
}
const rows = (t: RawTables) => t as unknown as Rows;
const at = new Date('2026-10-31T12:00:00Z');
const listing = (
  date = '10/1/2026 7:36:33 AM',
  size = '96583215',
  link = '/avdata/FileDirectory/DownloadFile?fileID=avall.zip',
) =>
  `<table><tr><td>avall.zip</td><td>${date}</td><td>${size}</td><td><a href="${link}">avall.zip</a></td></tr></table>`;

describe('source advertisement and real remote freshness', () => {
  it('parses the observed row without inventing a timezone', () => {
    expect(parseListing(listing())).toEqual({
      advertisedAtLocal: '2026-10-01T07:36:33',
      bytes: 96583215,
    });
    expect(parseListing(listing('11/1/2026 12:00:00 AM')).advertisedAtLocal).toBe(
      '2026-11-01T00:00:00',
    );
  });
  it.each([
    listing() + listing(),
    listing('2/30/2026 7:36:33 AM'),
    listing(undefined, '-1'),
    listing(undefined, '9999999999'),
    listing(undefined, undefined, 'https://attacker.test/avall.zip'),
    '<table><tr><td>avall.zip<script>SENTINEL</script></td></tr></table>',
  ])('rejects ambiguous/hostile source metadata', (html) => {
    expect(() => parseListing(html)).toThrow(ImportFailure);
  });
  it('a local hash, listing response or restart cannot reset the seven-day clock', () => {
    expect(refreshOwed(null, at)).toBe(true);
    expect(refreshOwed('2026-10-24T12:00:00Z', at)).toBe(true);
    expect(refreshOwed('2026-10-24T12:00:00.001Z', at)).toBe(false);
  });
  it('stops acquisition at the explicit April instant before any HTTP call', async () => {
    let calls = 0;
    const source = new AvallSource({
      now: () => new Date(SOURCE_CUTOFF),
      sleep: async () => {},
      fetch: async () => {
        calls++;
        throw new Error('must not fetch');
      },
    });
    await expect(source.inspect()).rejects.toMatchObject({ reason: 'source_retired' });
    expect(calls).toBe(0);
  });
  it.each(['inspect', 'acquire'] as const)(
    'rechecks the April cutoff after %s retry backoff',
    async (method) => {
      let now = SOURCE_CUTOFF - 1,
        calls = 0;
      const source = new AvallSource({
        now: () => new Date(now),
        sleep: async () => {
          now = SOURCE_CUTOFF;
        },
        fetch: async () => {
          calls++;
          return new Response('', { status: 429, headers: { 'retry-after': '1' } });
        },
      });
      const root = await mkdtemp(join(tmpdir(), 'import-cutoff-'));
      try {
        await expect(
          method === 'inspect'
            ? source.inspect()
            : source.acquire(
                { advertisedAtLocal: '2027-04-01T00:00:00', bytes: 4 },
                new ManagedSpace(root),
              ),
        ).rejects.toMatchObject({ reason: 'source_retired' });
        expect(calls).toBe(1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe('frozen snapshot policy and typed source digests', () => {
  it.each(
    Object.entries(CONSUMED_CODES).flatMap(([table, columns]) =>
      Object.keys(columns).map((column) => [table, column]),
    ),
  )(
    'reviews a newly observed raw %s.%s value even in one row with an unchanged dictionary',
    (table, column) => {
      const a = corpus(),
        b = structuredClone(a);
      rows(b)[table!]![0]![column!] = 'NEW_CODE';
      const old = sourceFacts(a),
        next = sourceFacts(b);
      expect(next.dictionary).toEqual(old.dictionary);
      expect(compareSnapshots(old, next, at).failures).toContain('codes');
    },
  );
  it('uses consumer spelling for vocabularies while retaining raw spelling in provenance', () => {
    const a = corpus(2),
      b = structuredClone(a);
    rows(b).aircraft![0]!.acft_category =
      '  ' + rows(a).aircraft![0]!.acft_category!.toLowerCase() + '  ';
    const old = sourceFacts(a),
      next = sourceFacts(b);
    expect(next.consumedCodes).toEqual(old.consumedCodes);
    expect(next.digest).not.toBe(old.digest);
  });
  it('never attributes a comma-containing US ID to its foreign prefix', () => {
    const a = corpus();
    rows(a).events![0]!.ev_country = 'CAN';
    for (const table of TABLE_NAMES)
      for (const row of rows(a)[table]!) if (row.ev_id === 'EV1') row.ev_id = 'EV0,extra';
    const b = structuredClone(a);
    rows(b).events![1]!.dec_latitude = '999';
    const next = sourceFacts(b);
    expect([...next.quarantine.values()]).toEqual([{ foreignCoordinate: false }]);
    expect(compareSnapshots(sourceFacts(a), next, at).failures).toContain('quarantine');
  });
  it('allows ten new exactly-attributed foreign coordinate notes but never unknown identities', () => {
    const a = corpus();
    for (let i = 0; i < 11; i++) rows(a).events![i]!.ev_country = 'CAN';
    const b = structuredClone(a);
    for (let i = 0; i < 10; i++) rows(b).events![i]!.dec_latitude = '999';
    const old = sourceFacts(a);
    expect(compareSnapshots(old, sourceFacts(b), at).failures).not.toContain('quarantine');
    rows(b).events![10]!.dec_latitude = '999';
    expect(compareSnapshots(old, sourceFacts(b), at).failures).toContain('quarantine');
    const orphan = structuredClone(a);
    rows(orphan).engines![0]!.ev_id = 'UNKNOWN,EV0';
    const unknown = sourceFacts(orphan);
    expect([...unknown.quarantine.values()].every((q) => !q.foreignCoordinate)).toBe(true);
    expect(compareSnapshots(old, unknown, at).failures).toContain('quarantine');
  });
  it('prioritizes a newly changed multi-aircraft, multi-cause case beyond the first twenty changes', () => {
    const a = corpus(),
      r = rows(a);
    for (const table of ['aircraft', 'narratives']) {
      const row = r[table]!.find((x) => x.ev_id === 'EV999')!;
      r[table]!.push({
        ...row,
        aircraft_key: '2',
        ...(table === 'narratives' ? { narr_cause: 'A distinct second cause.' } : {}),
      });
    }
    const b = structuredClone(a);
    for (let i = 0; i < 25; i++) rows(b).events![i]!.ev_city += ' changed';
    rows(b).narratives!.find((x) => x.ev_id === 'EV999' && x.aircraft_key === '2')!.narr_cause +=
      ' Further reported detail.';
    const old = sourceFacts(a),
      next = sourceFacts(b),
      comparison = compareSnapshots(old, next, at);
    const sample = candidateSample(next, comparison);
    expect(
      next.normalized.cases
        .find((c) => c.ntsbNo === 'SYN999')!
        .sections.filter((s) => s.kind === 'probable_cause'),
    ).toHaveLength(2);
    expect(sample[0]).toBe('SYN999');
    expect(sample).toHaveLength(20);
    expect(candidateSample(next, comparison)).toEqual(sample);
  });
  it('sorts source rows by bytes, retaining multiplicity and timestamp/source changes', () => {
    const a = corpus(3),
      b = structuredClone(a);
    Object.values(rows(b)).forEach((r) => r.reverse());
    expect(sourceFacts(a).digest).toBe(sourceFacts(b).digest);
    rows(b).narratives![0]!.lchg_date = '2026-10-01T00:00:00';
    expect(sourceFacts(a).digest).not.toBe(sourceFacts(b).digest);
    rows(b).narratives!.push({ ...rows(b).narratives![0]! });
    expect(() => sourceFacts(b)).toThrow();
  });
  it('catches equal-length narrative changes and per-source losses hidden by other growth', () => {
    const a = corpus(),
      b = structuredClone(a);
    const facts = sourceFacts(a);
    rows(b).narratives![0]!.narr_cause = 'X'.repeat(rows(b).narratives![0]!.narr_cause!.length);
    expect(sourceFacts(b).digest).not.toBe(facts.digest);
    rows(b).narratives![0]!.narr_cause = '<br />';
    rows(b).narratives![1]!.narr_cause += ' More reported information.'.repeat(30);
    expect(compareSnapshots(facts, sourceFacts(b), at).failures).toContain('narrative_loss');
  });
  it('does not let additions mask removal or a changed event/case association', () => {
    const a = corpus(),
      b = corpus(1001);
    rows(b).events![0]!.ntsb_no = 'REPLACED';
    rows(b).aircraft![0]!.ntsb_no = 'REPLACED';
    expect(compareSnapshots(sourceFacts(a), sourceFacts(b), at).failures).toContain('removals');
  });
  it('passes identical data, and uses exact inclusive 3% growth / 5% changed boundaries', () => {
    const a = sourceFacts(corpus());
    expect(compareSnapshots(a, a, at).failures).toEqual([]);
    expect(compareSnapshots(a, sourceFacts(corpus(1030)), at).failures).not.toContain('events');
    expect(compareSnapshots(a, sourceFacts(corpus(1031)), at).failures).toContain('events');
    const changed = corpus();
    for (let i = 0; i < 50; i++) rows(changed).events![i]!.ev_city += ' changed';
    expect(compareSnapshots(a, sourceFacts(changed), at).failures).not.toContain('changed');
    rows(changed).events![50]!.ev_city += ' changed';
    expect(compareSnapshots(a, sourceFacts(changed), at).failures).toContain('changed');
  });
  it('counts new quarantine identities rather than the net anomaly count', () => {
    const a = sourceFacts(corpus()),
      b = sourceFacts(corpus());
    for (let i = 0; i < 10; i++) a.quarantine.set(`old-${i}`, { foreignCoordinate: true });
    for (let i = 0; i < 11; i++) b.quarantine.set(`new-${i}`, { foreignCoordinate: true });
    expect(compareSnapshots(a, b, at).failures).toContain('quarantine');
    b.quarantine.delete('new-10');
    expect(compareSnapshots(a, b, at).failures).not.toContain('quarantine');
    b.quarantine.set('new-0', { foreignCoordinate: false });
    expect(compareSnapshots(a, b, at).failures).toContain('quarantine');
  });
  it('checks unclamped raw future dates and backwards change coverage', () => {
    const a = sourceFacts(corpus(2)),
      b = sourceFacts(corpus(2));
    b.sourceDates.push('2099-01-01T00:00:00');
    expect(compareSnapshots(a, b, at).failures).toContain('source_dates');
    b.changeDates = ['2020-01-01T00:00:00'];
    expect(compareSnapshots(a, b, at).failures).toContain('source_coverage');
  });
  it('tests both sides of the eligibility count, loss and share bounds independently of structural verification', () => {
    const all = sourceFacts(corpus());
    const withEligible = (n: number) => {
      const copy = structuredClone(all);
      copy.normalized.cases.forEach((c, i) => {
        c.answerEligible = i < n;
      });
      return copy;
    };
    const old = withEligible(800);
    for (const [n, passes] of [
      [796, true],
      [795, false],
      [840, true],
      [841, false],
    ] as const) {
      expect(compareSnapshots(old, withEligible(n), at).failures.includes('eligible_count')).toBe(
        !passes,
      );
    }
    for (const [n, passes] of [
      [995, true],
      [994, false],
    ] as const) {
      expect(compareSnapshots(all, withEligible(n), at).failures.includes('eligible_losses')).toBe(
        !passes,
      );
    }
    for (const [n, passes] of [
      [780, true],
      [779, false],
      [820, true],
      [821, false],
    ] as const) {
      expect(compareSnapshots(old, withEligible(n), at).failures.includes('eligible_share')).toBe(
        !passes,
      );
    }
  });
  it('tests both inclusive narrative health bounds and the first failing integer', () => {
    const old = sourceFacts(corpus(1)),
      section = old.normalized.cases[0]!.sections[0]!;
    const health = (sections: number, characters: number) => {
      const f = structuredClone(old);
      f.normalized.cases[0]!.sections = Array.from({ length: sections }, (_, i) => ({
        ...section,
        text: i === 0 ? 'x'.repeat(characters - sections + 1) : 'x',
      }));
      return f;
    };
    const base = health(1000, 100_000);
    for (const [n, passes] of [
      [980, true],
      [979, false],
      [1100, true],
      [1101, false],
    ] as const) {
      expect(
        compareSnapshots(base, health(n, 100_000), at).failures.includes('section_count'),
      ).toBe(!passes);
    }
    for (const [n, passes] of [
      [98_000, true],
      [97_999, false],
      [110_000, true],
      [110_001, false],
    ] as const) {
      expect(compareSnapshots(base, health(1000, n), at).failures.includes('characters')).toBe(
        !passes,
      );
    }
  });
  it('does not lose a source row, dictionary meaning, covered start date or semantic version', () => {
    const a = sourceFacts(corpus(2)),
      b = structuredClone(a);
    b.narrativeSources.delete(
      [...b.narrativeSources.entries()].find(([, text]) => text.length > 0)![0],
    );
    b.consumedCodes.add('new consumed code');
    b.dictionary.set('new meaning', 'changed');
    b.normalized.cases.forEach((c) => {
      c.fields.evDate = '2020-01-01';
      c.fields.evYear = 2020;
    });
    b.normalized.completionMapping = { ...b.normalized.completionMapping, verified: true };
    expect(compareSnapshots(a, b, at).failures).toEqual(
      expect.arrayContaining([
        'narrative_loss',
        'codes',
        'dictionary',
        'source_start',
        'years',
        'mapping',
      ]),
    );
  });
});

describe('strict ES certification, status and journal boundaries', () => {
  it('counts skipped shards as a subset, not extra successful shards', () => {
    expect(() => strictShards({ total: 3, successful: 3, skipped: 2, failed: 0 })).not.toThrow();
    for (const s of [
      { total: 3, successful: 1, skipped: 2, failed: 0 },
      { total: 3, successful: 3, failed: 1 },
      undefined,
    ]) {
      expect(() => strictShards(s)).toThrow(ImportFailure);
    }
  });
  it('rejects timed-out, capped, missing and partial responses even with HTTP 200', () => {
    const r = {
      _shards: { total: 1, successful: 1, failed: 0 },
      timed_out: false,
      hits: { total: { value: 10, relation: 'eq' }, hits: [] },
    };
    expect(() => strictSearch(r)).not.toThrow();
    expect(() => strictSearch({ ...r, timed_out: true })).toThrow();
    expect(() =>
      strictSearch({ ...r, hits: { ...r.hits, total: { value: 10, relation: 'gte' } } }),
    ).toThrow();
  });
  it('accounts for every bulk response and rejects incomplete item lists', async () => {
    const fake = { bulk: async () => ({ errors: false, items: [] }) } as unknown as Client;
    await expect(
      certificationClient(fake).bulk({
        operations: [
          { create: { _id: 'SYN', _index: 'test' } },
          { ntsb_no: 'SYN', country: 'USA', aircraft: [], aircraft_count: 0 },
        ],
      }),
    ).rejects.toThrow(ImportFailure);
  });
  it('retains microsecond publication identity', () => {
    const a = {
      generationId: 1,
      casesIndex: 'cases',
      passagesIndex: 'passages',
      publishedAt: '2026-10-31T12:00:00.000001Z',
    };
    expect(sameManifest(a, { ...a, publishedAt: '2026-10-31T12:00:00.000002Z' })).toBe(false);
    expect(digest({ x: 1, y: 2 })).toBe(digest({ y: 2, x: 1 }));
  });
  it('never serializes causes or provider/SQL/source messages', () => {
    for (const origin of [
      'html',
      'csv',
      'mdb',
      'normalization',
      'bulk',
      'sql',
      'provider',
      'cleanup',
      'probe',
    ]) {
      const error = new Error(`${origin}: PRIVATE_SENTINEL`, {
        cause: new Error('PRIVATE_SENTINEL'),
      });
      const clean = safeFailure(error);
      expect(JSON.stringify(clean) + safeLog('verify', 'needs_review', clean.reason)).not.toContain(
        'PRIVATE_SENTINEL',
      );
      expect(clean.cause).toBeUndefined();
    }
  });
  it('computes the civil schedule across DST and skips backup windows', () => {
    const s = { enabled: true, localTime: '05:30', timeZone: 'Europe/Prague' };
    expect(nextCheck(new Date('2026-10-24T04:00:00Z'), s)).toBe('2026-10-25T04:30:00.000Z');
    expect(inBackupWindow(new Date('2026-10-31T03:40:00Z'))).toBe(true);
    expect(nextCheck(at, { ...s, enabled: false })).toBeNull();
  });
  it('enforces managed-space bytes and refuses symlink reuse/cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'import-space-'));
    try {
      const space = new ManagedSpace(root, {
        root: 20,
        workspace: 20,
        reserve: 0,
        raw: 20,
        expanded: 20,
        projected: 20,
        report: 20,
      });
      await writeFile(join(root, 'bytes'), Buffer.alloc(19));
      await expect(space.check(2)).rejects.toMatchObject({ reason: 'storage' });
      await symlink('/etc/passwd', join(root, 'link'));
      await expect(space.remove(join(root, 'link'))).rejects.toThrow(ImportFailure);
      await expect(fileDigest(join(root, 'link'))).rejects.toThrow(ImportFailure);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
