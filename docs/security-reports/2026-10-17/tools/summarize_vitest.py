"""Extract minimal evidence from a genuine Vitest JSON output; does not run tests."""
import argparse
import datetime as dt
import hashlib
import json
import pathlib


def summarize(source, label):
    raw = source.read_bytes()
    report = json.loads(raw)
    rows = []
    for suite in report.get("testResults", []):
        for case in suite.get("assertionResults", []):
            rows.append({"title": case["title"], "status": case["status"],
                         "duration_ms": case.get("duration"),
                         "failure_recorded": bool(case.get("failureMessages"))})
    start = report.get("startTime")
    return {"schema_version": 1, "label": label, "raw_sha256": hashlib.sha256(raw).hexdigest(),
            "started_at_utc": dt.datetime.fromtimestamp(start / 1000, dt.timezone.utc).isoformat() if start else None,
            "total": report["numTotalTests"], "passed": report["numPassedTests"],
            "failed": report["numFailedTests"], "skipped": report["numPendingTests"],
            "success": report["success"], "cases": rows,
            "redaction": "No absolute source paths, stack traces, source excerpts, credentials or response bodies included."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=pathlib.Path)
    parser.add_argument("--label", required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    result = summarize(args.source, args.label)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{result['label']}: {result['passed']} passed, {result['failed']} failed, {result['skipped']} skipped")
