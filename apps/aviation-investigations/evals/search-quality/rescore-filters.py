#!/usr/bin/env python3
"""Offline Task 24 rescore. Reads frozen prior artifacts; never loads app settings.

Run with --prior-app pointing at the app containing the original evaluation files
and --output pointing inside the evaluator's worktree. No external dependencies.
"""

import argparse
import collections
import hashlib
import json
import math
from pathlib import Path


SOURCES = {
    "evals/scope/dev.json": "2d12e61f254bb592457b6c65e22ebb8aa4da2a90d5dd9f07a82268a2dbb97683",
    "evals/scope/manifest.dev1.json": "fd210a32d889d0bb5b1a1b92efad0369b456b1b287bd80c8705cb31200aef26f",
    "data/work/scope23e/attempts.jsonl": "38ff6499e7c4aeddf589d4ea93c0f3c0b10fc85938dbde9e6374c96eef262d7f",
    "data/work/scope23e/dev1.metrics.json": "41b7cc19d9efc49387fbf6f07719d4b2fd497b980fce5d01a61c630ad61ee1f8",
    "evals/scope-advisory/confirmation.json": "ba83e78deadb54c00774f2803bfacbac11ef6f440cf88825c491d16ac58b3390",
    "evals/scope-advisory/judgments.json": "bdc1d9015407b0a4d484cbe3abb177a20a4e50a32449ebc7d112f231aabb7d0b",
    "evals/scope-advisory/manifest.confirmation.json": "2c7a50e9e88b967d81f6f6664a2a6c96aa84bfdcb7a7dcd82d55f11d1155f0d0",
    "data/work/scope23e2/observations.json": "ef9fab5287310c5c68c8a14aa9928fb2c50b573ca8e74ca8b22102897ececa73",
    "data/work/scope23e2/audits.json": "fe5ad73782633de661a2b3ff19cbf7a3f1eef7c32954973334d44424f7e31919",
}

FIELDS = ["phase", "injury", "conditions", "light", "category", "engine",
          "far_part", "purpose", "state", "yearFrom", "yearTo"]


def wilson(success, total):
    if total == 0:
        return {"success": success, "total": total, "rate": None,
                "lower": None, "upper": None}
    z = 1.959963984540054
    p = success / total
    d = 1 + z * z / total
    c = (p + z * z / (2 * total)) / d
    h = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / d
    return {"success": success, "total": total, "rate": p,
            "lower": max(0, c - h), "upper": min(1, c + h)}


def values(filters, field):
    if field == "yearRange":
        return {k: filters[k] for k in ("yearFrom", "yearTo") if k in filters}
    value = filters.get(field)
    if value is None:
        return []
    return sorted(set(str(v) for v in (value if isinstance(value, list) else [value])))


def score_field(questions, results, field):
    tp = fp = fn = critical_fp = 0
    errors = []
    for q in questions:
        gold = q["gold"]
        result = results[q["id"]]
        output = result["value"] or {}
        want = values(gold.get("filters", {}) if gold["kind"] == "search" else {}, field)
        got = values(output.get("filters", {}) if output.get("kind") == "search" else {}, field)
        if want and want == got:
            tp += 1
        else:
            fp += bool(got)
            fn += bool(want)
            critical_fp += bool(got) and q["critical"]
            if got or want:
                errors.append({"id": q["id"], "critical": q["critical"],
                               "gold": want, "predicted": got,
                               "false_positive": bool(got), "false_negative": bool(want)})
    return {"tp": tp, "fp": fp, "fn": fn, "critical_fp": critical_fp,
            "precision": wilson(tp, tp + fp), "recall": wilson(tp, tp + fn),
            "errors": errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prior-app", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    contents = {}
    for relative, expected in SOURCES.items():
        data = (args.prior_app / relative).read_bytes()
        actual = hashlib.sha256(data).hexdigest()
        if actual != expected:
            raise SystemExit(f"Frozen source differs: {relative}")
        contents[relative] = data

    def read(relative):
        return json.loads(contents[relative])

    dev = read("evals/scope/dev.json")["items"]
    attempts = [json.loads(line) for line in contents["data/work/scope23e/attempts.jsonl"].splitlines()]
    selected = [r for r in attempts if r.get("phase") == "scope_dev1" and r.get("event") == "result"]
    assert len(dev) == len(selected) == 85
    assert all(len(r["ids"]) == 1 for r in selected)
    by_id = {r["ids"][0]: r for r in selected}
    assert len(by_id) == 85 and set(by_id) == {q["id"] for q in dev}
    fields = {f: score_field(dev, by_id, f) for f in FIELDS}
    aggregate = {k: sum(v[k] for v in fields.values()) for k in ("tp", "fp", "fn")}
    aggregate["precision"] = wilson(aggregate["tp"], aggregate["tp"] + aggregate["fp"])
    aggregate["recall"] = wilson(aggregate["tp"], aggregate["tp"] + aggregate["fn"])
    critical_ids = sorted({e["id"] for v in fields.values() for e in v["errors"]
                           if e["critical"] and e["false_positive"]})
    failed = sum(bool(r["error"]) or r["value"] is None for r in selected)
    stored = read("data/work/scope23e/dev1.metrics.json")
    # Compare this independent recomputation against the original evaluator.
    for name, got in list(fields.items()) + [("filter", aggregate)]:
        expected = stored["filter"] if name == "filter" else stored["fields"][name]
        for key in ("tp", "fp", "fn"):
            assert got[key] == expected[key], (name, key)
        for metric in ("precision", "recall"):
            for key in ("rate", "lower", "upper"):
                assert math.isclose(got[metric][key], expected[metric][key], abs_tol=1e-12), (name, metric, key)
    assert len(critical_ids) == stored["criticalHardFilterErrors"]["success"] == 6
    assert failed == stored["failedCalls"]["success"] == 1

    questions2 = read("evals/scope-advisory/confirmation.json")["items"]
    observations = read("data/work/scope23e2/observations.json")
    items = observations["items"]
    assert len(items) == len(questions2) == 227
    q2 = {q["id"]: q for q in questions2}
    assert len({o["id"] for o in items}) == 227 and {o["id"] for o in items} == set(q2)
    assert all(set(q["gold"]) == {"route", "hint"} for q in questions2)
    assert observations["manifestSha256"] == SOURCES["evals/scope-advisory/manifest.confirmation.json"]
    emissions = {}
    for field in FIELDS + ["yearRange"]:
        hits = [o for o in items if values((o["raw"] or {}).get("filters", {}), field)]
        emissions[field] = {
            "emitted_questions": len(hits),
            "critical_question_emissions": sum(q2[o["id"]]["critical"] for o in hits),
            "ids": [o["id"] for o in hits],
            "precision": None, "recall": None,
            "reason": "No exact field gold was registered for 23E2; routing and usability are not field gold.",
        }

    payload = {
        "version": "task-24-filter-rescore-v1", "checked": "2026-10-25",
        "sources_sha256": SOURCES,
        "method": "Complete field equality, no partial OR credit; two-sided 95% Wilson; zero denominator is null.",
        "dev1": {"questions": 85, "critical_questions": sum(q["critical"] for q in dev),
                 "fields": fields, "aggregate": aggregate,
                 "year_range_joint": score_field(dev, by_id, "yearRange"),
                 "critical_error_questions": critical_ids, "failed_calls": failed,
                 "matches_original_metrics": True},
        "scope_e3": {"questions": 227,
                     "routing_gold": dict(collections.Counter(q["gold"]["route"] for q in questions2)),
                     "failed_calls": sum(bool(o["error"]) for o in items),
                     "questions_with_filters": sum(bool((o["raw"] or {}).get("filters")) for o in items),
                     "emissions": emissions},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print("Verified 85 dev1 results against stored metrics; 227 scope.e3 rows have no field gold.")
    print("Paid calls: 0. Output SHA256:", hashlib.sha256(args.output.read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
