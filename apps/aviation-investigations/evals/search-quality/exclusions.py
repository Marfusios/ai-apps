"""Build an auditable historical-exposure exclusion set, without services or models."""
import argparse
import hashlib
import json
import re
from pathlib import Path

CASE = re.compile(r"\b[A-Z]{3}[0-9]{2}[A-Z]{2}[0-9]{2,4}\b")
QUESTION = re.compile(r'"(?:question|questionText)"\s*:\s*("(?:[^"\\]|\\.)*")')
FINDING = re.compile(r'["\']([0-9]{10})["\']')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--source', action='append', required=True, help='portable-label=directory')
    p.add_argument('--out', required=True, type=Path)
    a = p.parse_args()
    cases, questions, findings, events = set(), set(), set(), set()
    files, seen = [], set()
    for spec in a.source:
        label, directory = spec.split('=', 1)
        root = Path(directory)
        if not root.is_dir():
            raise SystemExit(f'Missing historical source: {label}')
        for path in sorted(root.rglob('*')):
            if not path.is_file() or path.suffix not in {'.json', '.jsonl', '.ts', '.md', '.csv'}:
                continue
            if any(x in path.parts for x in ['node_modules', '.git']):
                continue
            data = path.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if digest in seen:
                continue
            seen.add(digest)
            text = data.decode('utf-8', errors='replace')
            found = set(CASE.findall(text))
            cases.update(found)
            for value in QUESTION.findall(text):
                questions.add(json.loads(value))
            findings.update(FINDING.findall(text))
            # Exact code clauses of historical coded specifications (not unrelated three-digit numbers).
            if path.name == 'dataset.json':
                try:
                    obj = json.loads(text)
                    for q in obj.get('questions', []):
                        for c in q.get('codeSet', {}).get('clauses', []):
                            (findings if c['kind'] == 'finding' else events).update(c['codes'])
                except (json.JSONDecodeError, AttributeError):
                    pass
            files.append({'source': label, 'path': str(path.relative_to(root)), 'sha256': digest,
                          'caseReferences': len(found), 'bytes': len(data)})
    out = {'version': 'task24-exclusions-v1', 'files': files, 'cases': sorted(cases),
           'questions': sorted(questions), 'findingCodes': sorted(findings),
           'findingFamilies': sorted({s[:8] for s in findings}), 'eventCodes': sorted(events),
           'method': 'All case references in exposed eval artifacts, prompts and fixtures; exact question strings; historical code clauses.'}
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(out, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({k: len(out[k]) for k in ['files', 'cases', 'questions', 'findingFamilies', 'eventCodes']}))


if __name__ == '__main__':
    main()
