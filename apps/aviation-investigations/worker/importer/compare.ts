import { digest, type SnapshotFacts } from './provenance.js';
import { POLICY_VERSION, type SourceObservation } from './contracts.js';

export interface Comparison {
  policy: typeof POLICY_VERSION;
  baseline: string;
  candidate: string;
  ok: boolean;
  failures: string[];
  changed: string[];
  added: string[];
  removed: string[];
  reassociated: string[];
  usMembershipLost: string[];
  cases: string[];
  counts: Record<string, number>;
  hash: string;
  observations?: { accepted: SourceObservation; candidate: SourceObservation };
}
const ratio = (value: number, baseline: number, low: number, high: number): boolean =>
  BigInt(value) * 1000n >= BigInt(baseline) * BigInt(low) &&
  BigInt(value) * 1000n <= BigInt(baseline) * BigInt(high);

export function compareSnapshots(
  old: SnapshotFacts,
  next: SnapshotFacts,
  observedAt: Date,
  observations?: { accepted: SourceObservation; candidate: SourceObservation },
): Comparison {
  const failures: string[] = []; // Informational differences only; never an admission predicate.
  const check = (name: string, ok: boolean) => {
    if (!ok) failures.push(name);
  };
  const a = old.normalized,
    b = next.normalized;
  const ca = new Map(a.cases.map((c) => [c.ntsbNo, c])),
    cb = new Map(b.cases.map((c) => [c.ntsbNo, c]));
  const changed = [...old.perCase]
    .filter(([key, sha]) => next.perCase.has(key) && next.perCase.get(key) !== sha)
    .map(([key]) => key)
    .sort();
  const added = [...cb.keys()].filter((k) => !ca.has(k)).sort();
  const removed = [...old.identities.keys()].filter((key) => !next.identities.has(key)).sort();
  const reassociated = [...old.identities]
    .filter(([key, id]) => next.identities.has(key) && next.identities.get(key) !== id)
    .map(([key]) => key)
    .sort();
  const usMembershipLost = a.cases
    .filter((c) => c.isUs && cb.get(c.ntsbNo)?.isUs !== true)
    .map((c) => c.ntsbNo)
    .sort();
  if (old.digest !== next.digest && observations) {
    check(
      'source_reissued',
      observations.candidate.advertisedAtLocal > observations.accepted.advertisedAtLocal,
    );
    const gap =
      Date.parse(`${observations.candidate.advertisedAtLocal}Z`) -
      Date.parse(`${observations.accepted.advertisedAtLocal}Z`);
    check('baseline_required', Number.isFinite(gap) && gap <= 62 * 86_400_000);
  }
  const count = (s: SnapshotFacts) => ({
    e: s.normalized.cases.length,
    u: s.normalized.cases.filter((c) => c.isUs).length,
    a: s.normalized.cases.filter((c) => c.answerEligible).length,
  });
  const o = count(old),
    n = count(next);
  check('baseline_nonempty', o.e > 0 && o.u > 0 && o.a > 0);
  check('events', ratio(n.e, o.e, 1000, 1030));
  check('removals', removed.length === 0);
  check('reassociations', reassociated.length === 0);
  check('us_membership', usMembershipLost.length === 0);
  check('us_count', ratio(n.u, o.u, 1000, 1030));
  check('changed', BigInt(changed.length) * 100n <= BigInt(o.e) * 5n);
  check('eligible_count', ratio(n.a, o.a, 995, 1050));
  const lostEligible = a.cases.filter(
    (c) => c.answerEligible && cb.get(c.ntsbNo)?.answerEligible !== true,
  ).length;
  check('eligible_losses', BigInt(lostEligible) * 1000n <= BigInt(o.a) * 5n);
  const shareDiff = BigInt(n.a) * BigInt(o.u) - BigInt(o.a) * BigInt(n.u);
  check(
    'eligible_share',
    (shareDiff < 0n ? -shareDiff : shareDiff) * 100n <= 2n * BigInt(n.u) * BigInt(o.u),
  );
  const sections = (s: SnapshotFacts) =>
    s.normalized.cases.filter((c) => c.answerEligible).flatMap((c) => c.sections);
  const os = sections(old),
    ns = sections(next);
  check('section_count', ratio(ns.length, os.length, 980, 1100));
  check(
    'characters',
    ratio(
      ns.reduce((v, s) => v + s.text.length, 0),
      os.reduce((v, s) => v + s.text.length, 0),
      980,
      1100,
    ),
  );
  check(
    'narrative_loss',
    [...old.narrativeSources].every(
      ([key, text]) => !text || Boolean(next.narrativeSources.get(key)),
    ),
  );
  const newQuarantine = [...next.quarantine].filter(([key]) => !old.quarantine.has(key));
  check(
    'quarantine',
    newQuarantine.length <= 10 && newQuarantine.every(([, q]) => q.foreignCoordinate),
  );
  check(
    'grandfathered_quarantine',
    [...old.quarantine.values()].every((q) => q.foreignCoordinate),
  );
  check(
    'codes',
    [...next.consumedCodes].every((k) => old.consumedCodes.has(k)),
  );
  check(
    'dictionary',
    [...old.dictionary].every(([k, v]) => next.dictionary.get(k) === v) &&
      [...next.dictionary.keys()].every((k) => old.dictionary.has(k)),
  );
  check(
    'mapping',
    digest(a.completionMapping) === digest(b.completionMapping) &&
      b.completionMapping.version === 'v1-empirical' &&
      !b.completionMapping.verified &&
      a.citationTextVersion === b.citationTextVersion &&
      a.fieldNormalizationVersion === b.fieldNormalizationVersion,
  );
  check(
    'cause_status',
    b.cases.every((c) => !(c.isUs && c.hasProbableCause) || c.rawStatus === 'B'),
  );
  const cutoff = new Date(observedAt.getTime() + 86_400_000).toISOString().slice(0, 10);
  const validDate = (s: string) =>
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(`${s.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === s.slice(0, 10);
  check(
    'source_dates',
    next.sourceDates.length > 0 &&
      next.sourceDates.every((s) => validDate(s) && s.slice(0, 10) <= cutoff),
  );
  const latest = (s: SnapshotFacts) => [...s.changeDates].sort().at(-1) ?? '';
  check('source_coverage', latest(old) !== '' && latest(next) >= latest(old));
  const start = (s: SnapshotFacts) =>
    s.normalized.cases
      .map((c) => c.fields.evDate)
      .filter((d): d is string => typeof d === 'string')
      .sort()[0] ?? '';
  check(
    'source_start',
    start(old) !== '' &&
      start(next) !== '' &&
      start(next) <= start(old) &&
      start(next).slice(0, 4) === start(old).slice(0, 4),
  );
  const years = new Set(b.cases.map((c) => c.fields.evYear));
  check(
    'years',
    a.cases.every((c) => years.has(c.fields.evYear)),
  );
  const health: Record<string, number> = {
    baselineEvents: o.e,
    baselineUs: o.u,
    baselineEligible: o.a,
    baselineSections: os.length,
    candidateSections: ns.length,
    baselineCharacters: os.reduce((n, s) => n + s.text.length, 0),
    candidateCharacters: ns.reduce((n, s) => n + s.text.length, 0),
  };
  for (const kind of ['factual', 'analysis', 'probable_cause'] as const) {
    for (const [label, list] of [
      ['baseline', os],
      ['candidate', ns],
    ] as const) {
      const found = list.filter((s) => s.kind === kind);
      health[`${label}_${kind}_sections`] = found.length;
      health[`${label}_${kind}_characters`] = found.reduce((n, s) => n + s.text.length, 0);
    }
  }
  const report: Omit<Comparison, 'hash'> = {
    policy: POLICY_VERSION,
    baseline: old.digest,
    candidate: next.digest,
    ok: true,
    failures,
    ...(observations ? { observations } : {}),
    changed,
    added,
    removed,
    reassociated,
    usMembershipLost,
    cases: [
      ...new Set([
        ...changed,
        ...added,
        ...removed,
        ...reassociated,
        ...usMembershipLost,
        ...(failures.includes('dictionary')
          ? [...old.identities.keys(), ...next.identities.keys()]
          : []),
      ]),
    ].sort(),
    counts: {
      events: n.e,
      us: n.u,
      eligible: n.a,
      changed: changed.length,
      added: added.length,
      removed: removed.length,
      lostEligible,
      newQuarantine: newQuarantine.length,
      ...health,
    },
  };
  return { ...report, hash: digest(report) };
}
