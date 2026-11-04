"""Free Part 5 sizing/exposure audit. Never reads a fresh model response or calls a service."""
import argparse
import collections
import hashlib
import json
import math
import random
import re
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from construct import Builder, AREAS, STATES


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, obj):
    Path(path).write_text(json.dumps(obj, indent=2, ensure_ascii=False) + '\n')


def size_study(results):
    conf = results['confirmation']
    base = {q['id']: q for q in conf['baseline']['perQuestion']}
    narrow = {}
    for metric in ['narrowR20', 'narrowR10']:
        groups = collections.defaultdict(list)
        for q in conf['comparison']['summary']['perQuestion']:
            if q['class'] == 'narrow':
                groups[q['group']].append(q['metrics'][metric] - base[q['id']]['metrics'][metric])
        vals = [statistics.mean(v) for v in groups.values()]
        narrow[metric] = {'groups': dict(zip(groups, vals)), 'mean': statistics.mean(vals), 'sd': statistics.stdev(vals)}
    z = statistics.NormalDist().inv_cdf(.95)
    # Normal planning with estimated between-group SD; t critical value conservatively
    # allows for estimating that SD again. It does not change the actual bootstrap test.
    trials = 100_000
    curve = []
    for n in range(4, 85, 4):
        rng = random.Random(2026102505 + n)
        df = n - 1
        t = z + (z**3 + z)/(4*df) + (5*z**5 + 16*z**3 + 3*z)/(96*df**2) + (3*z**7 + 19*z**5 + 17*z**3 - 15*z)/(384*df**3)
        counts = collections.Counter()
        for _ in range(trials):
            for metric, v in narrow.items():
                mean = rng.gauss(v['mean'], v['sd']/math.sqrt(n))
                se = v['sd']*math.sqrt(rng.gammavariate(df/2, 2)/df/n)
                margin = 0 if metric == 'narrowR20' else -.02
                point = mean >= (.05 if metric == 'narrowR20' else -.02)
                interval = mean - t*se > margin
                counts[metric] += point and interval
                counts[metric + 'Point'] += point
                counts[metric + 'Interval'] += interval
        powers = {k: v/trials for k, v in counts.items()}
        # The one-sided simulation lower bound also has to exceed 80%, avoiding a
        # sample-size decision based on a lucky simulation at the boundary.
        lower = {k: p - 1.645*math.sqrt(p*(1-p)/trials) for k, p in powers.items()}
        curve.append({'groupsPerClass': n, 'power': powers, 'simulationLower95': lower})
        if min(lower.values()) >= .8:
            break
    required = curve[-1]['groupsPerClass']
    return {'version': 'task24-confirmation2-power-v1', 'source': 'spent confirmation 1, paired group differences, QH100 minus Q0',
            'planningLimitation': 'QH50 may have different effects; this sizes at the observed confirmation-1 effects as authorized. Normal between-group planning approximation, not a population guarantee or a changed test.',
            'simulationSeedBase': 2026102505, 'trialsPerSize': trials, 'narrow': narrow, 'curve': curve,
            'requiredGroupsPerClass': required, 'requiredPerAreaClass': required//4,
            'questions': 4*required, 'searches': 24*required,
            'worstBlockMicros': 12*required*(2500+9000), 'phaseCapMicros': 8_000_000,
            'unchangedTest': 'Question mean of 3 samples, two paraphrases per group, 10000 connected-group bootstrap resamples; R20 delta>=.05 and one-sided lower>0; R10 delta and lower>-.02.'}


def exposures(original, roots):
    ex = json.loads(Path(original).read_text())
    cases, questions = set(ex['cases']), set(ex['questions'])
    findings, events = set(ex['findingCodes']), set(ex['eventCodes'])
    families = set(ex['findingFamilies'])
    files, seen = [], set()
    case_pattern = re.compile(r'\b[A-Z]{3}[0-9]{2}[A-Z]{2}[0-9]{2,4}\b')

    def walk(obj):
        if isinstance(obj, dict):
            for key in ['question', 'questionText']:
                if isinstance(obj.get(key), str): questions.add(obj[key])
            family = obj.get('family')
            if isinstance(family, str):
                if re.fullmatch(r'ev\d{3}', family): events.add(family[2:])
                elif re.fullmatch(r'\d{8}', family): families.add(family)
            if obj.get('kind') in ['finding', 'event'] and isinstance(obj.get('codes'), list):
                (findings if obj['kind'] == 'finding' else events).update(obj['codes'])
            for v in obj.values(): walk(v)
        elif isinstance(obj, list):
            for v in obj: walk(v)

    for label, root in roots:
        root = Path(root)
        paths = [root] if root.is_file() else sorted(root.rglob('*'))
        for p in paths:
            if not p.is_file() or p.suffix not in ['.json', '.jsonl', '.md', '.ts']: continue
            if label == 'shared-task24' and (not p.name.startswith('task-24-') or any(x in p.name for x in ['part5', 'confirmation2', 'c2'])): continue
            data = p.read_bytes()
            h = hashlib.sha256(data).hexdigest()
            if h in seen: continue
            seen.add(h)
            text = data.decode('utf8')
            found = set(case_pattern.findall(text)); cases.update(found)
            if p.suffix == '.json': walk(json.loads(text))
            elif p.suffix == '.jsonl':
                for s in text.splitlines():
                    if s.strip(): walk(json.loads(s))
            files.append({'source': label, 'path': p.name if root.is_file() else str(p.relative_to(root)), 'sha256': h, 'caseReferences': len(found)})
    families.update(v[:8] for v in findings)
    return {'version': 'task24-part5-exclusions-v1', 'priorManifestSha256': sha(original), 'priorFiles': ex['files'],
            'additionalFiles': files, 'cases': sorted(cases), 'questions': sorted(questions),
            'findingCodes': sorted(findings), 'findingFamilies': sorted(families), 'eventCodes': sorted(events),
            'method': 'Prior complete exposure manifest plus all recorded Task24 development/confirmation ranks and candidate pools, scope results, field seeds, frozen specifications, reports and coded specifications. Corpus metadata is a construction source, not a prior evaluation output.'}


def assess(corpus, ex, required):
    b = Builder(corpus, ex)
    rows = []
    # No previous fresh candidate claims ownership: these are optimistic upper bounds
    # before cross-group overlap/semantic-near-duplicate rejection, so a shortfall proves
    # infeasibility without inventing independent observations.
    def feasible(family, cls):
        rs = b.rows[family]
        for category in [None] + sorted({b.air[r]['category'] for r in rs if b.air[r]['category']}):
            ns = {r[0] for r in rs if category is None or b.air[r]['category']==category}
            for lo in range(2008,2027):
                for hi in range(lo,2027):
                    buckets=collections.defaultdict(set)
                    for n in ns:
                        c=b.cases[n]
                        if c['ev_year'] is not None and lo<=c['ev_year']<=hi and c['state'] in STATES: buckets[c['state']].add(n)
                    counts=[len(v) for v in buckets.values() if not v & b.bad]
                    if cls=='narrow':
                        if any(1<=n<=20 for n in counts): return True
                    else:
                        # Exact bounded subset-sum over ALL safe states. The original
                        # constructor's greedy witness is not an impossibility proof.
                        reach=[1]+[0]*8
                        for n in counts:
                            if n>100:continue
                            for k in range(8,0,-1):reach[k] |= (reach[k-1]<<n) & ((1<<101)-1)
                        if any(r>>21 for r in reach):return True
        return False

    for area, prefix in AREAS.items():
        families = [k for k in b.rows if k in b.desc and k.startswith(prefix) and k not in b.known_families
                    and not any(s in b.topic(k) for s in ['(general)', 'miscellaneous', 'unknown', 'not determined'])
                    and (area != 'aircraft_systems' or k.startswith(('0101', '0102', '0103', '0104', '0105', '0107')))]
        for cls in ['broad', 'narrow']:
            available, exact = [], []
            for family in sorted(families):
                if feasible(family,cls):exact.append(family)
                candidate = b.candidate(family, cls)
                if candidate:
                    _, filters, gold = candidate
                    assert set(gold) == b.members(family, filters) and not set(gold) & b.bad
                    available.append({'family': family, 'topic': b.topic(family), 'filters': filters, 'relevant': gold})
            row = {'area': area, 'class': cls, 'required': required//4, 'unexposedInterpretableFamilies': len(families),
                   'eligiblePredicateUpperBound': len(exact), 'shortfallAtLeast': max(0, required//4-len(exact)),
                   'feasibleFamilies':exact, 'candidates': available}
            rows.append(row)
            print(json.dumps({k: v for k, v in row.items() if k not in ['candidates','feasibleFamilies']}), flush=True)
    return {'version': 'task24-confirmation2-feasibility-v1', 'requiredGroupsPerClass': required,
            'freshCasesInCorpus': sum(c['ntsb_no'] not in b.bad for c in corpus['cases']), 'cells': rows,
            'provenInfeasible': any(r['shortfallAtLeast'] for r in rows),
            'limits': 'Same original predicate grammar: one unseen code family, one state narrow/up to eight states broad, optional same-aircraft category, contiguous 2008-2026 years. No subtraction of exposed gold, no alternate modifiers of old topics. Counts are upper bounds; shared gold and semantic leakage can only reduce them.'}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--reports', required=True)
    a = p.parse_args()
    out = Path('evals/search-quality/part5/frozen')
    out.mkdir(parents=True, exist_ok=True)
    if (out/'field-manifest.json').exists(): raise RuntimeError('Part 5 is frozen; do not overwrite it')
    reports = Path(a.reports)
    power = size_study(json.loads((reports/'task-24-eval-results.json').read_text()))
    write(out/'power.json', power)
    roots = [('task24-frozen', 'evals/search-quality/frozen'), ('task24-selection', 'data/work/task24/selection'),
             ('task24-confirmation', 'data/work/task24/confirmation'), ('task24-fields', 'data/work/task24/fields'),
             ('coded-specifications', 'evals/retrieval/coded/dataset.json'), ('shared-task24', reports)]
    ex = exposures('data/work/task24/exclusions.json', roots)
    write(out/'exclusions.json', ex)
    print(json.dumps({'requiredGroupsPerClass': power['requiredGroupsPerClass'], 'worstBlockMicros': power['worstBlockMicros'],
                      'exclusions': {k: len(ex[k]) for k in ['cases', 'questions', 'findingFamilies', 'eventCodes']}}), flush=True)
    result = assess(json.loads(Path('data/work/task24/corpus.json').read_text()), ex, power['requiredGroupsPerClass'])
    result['hashes'] = {k: sha(v) for k, v in {'corpus': 'data/work/task24/corpus.json', 'exclusions': out/'exclusions.json', 'power': out/'power.json'}.items()}
    write(out/'feasibility.json', result)
    # Demonstrate that the shortfall is not an artifact of conservatively excluding
    # families inspected but rejected during historical free construction.
    old=json.loads(Path('data/work/task24/exclusions.json').read_text())
    families,events=set(old['findingFamilies']),set(old['eventCodes'])
    for path in ['evals/search-quality/frozen/confirmation.json','evals/retrieval/coded/dataset.json']:
        for q in json.loads(Path(path).read_text())['questions']:
            for clause in q['codeSet']['clauses']:
                if clause['kind']=='finding':families.update(x[:8] for x in clause['codes'])
                else:events.update(clause['codes'])
    optimistic={**ex,'findingFamilies':sorted(families),'eventCodes':sorted(events)}
    sensitivity=assess(json.loads(Path('data/work/task24/corpus.json').read_text()),optimistic,power['requiredGroupsPerClass'])
    sensitivity.update({'sensitivity':'Optimistically allow all previously rejected candidate families; exclude only historical and Task24 actual question-specification families. Keep every previously exposed case excluded. This is not permission to reuse inspected topics.',
                        'findingFamiliesExcluded':len(families),'eventCodesExcluded':len(events)})
    write(out/'feasibility-relaxed-exposure.json',sensitivity)


if __name__ == '__main__': main()
