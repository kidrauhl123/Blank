"""Read-only/unauthenticated BankPilot HTTP boundary probes; Python stdlib only."""
import argparse
import datetime as dt
import hashlib
import json
import pathlib
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def run(base):
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("Only an explicit http://127.0.0.1:PORT local test target is allowed")
    origin = base.rstrip("/")
    cases = [
        ("HTTP-01", "GET", "/api/bootstrap", {}, 401, "AUTHENTICATION_REQUIRED"),
        ("HTTP-02", "POST", "/api/v1/transfers/prepare", {}, 403, "INVALID_ORIGIN"),
        ("HTTP-03", "POST", "/api/v1/transfers/prepare", {"Origin": "https://attacker.invalid"}, 403, "INVALID_ORIGIN"),
        ("HTTP-04", "POST", "/api/v1/transfers/prepare", {"Origin": origin}, 401, "AUTHENTICATION_REQUIRED"),
        ("HTTP-05", "POST", "/api/v1/transfers/prepare", {"Origin": origin, "Authorization": "Bearer synthetic-invalid"}, 403, "BANK_APP_SESSION_REQUIRED"),
        ("HTTP-06", "GET", "/api/bootstrap", {"Authorization": "Bearer synthetic-invalid"}, 403, "BANK_APP_SESSION_REQUIRED"),
        ("HTTP-07", "POST", "/api/agent/app", {"Origin": origin}, 401, "AUTHENTICATION_REQUIRED"),
        ("HTTP-08", "GET", "/api/v1/statements", {}, 401, "AUTHENTICATION_REQUIRED"),
    ]
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    rows = []
    for ident, method, path, headers, expected, expected_code in cases:
        req = urllib.request.Request(origin + path, data=b"{}" if method == "POST" else None,
                                     headers={"Content-Type": "application/json", **headers}, method=method)
        started = dt.datetime.now(dt.timezone.utc).isoformat()
        try:
            response = opener.open(req, timeout=60)
        except urllib.error.HTTPError as error:
            response = error
        except (urllib.error.URLError, TimeoutError) as error:
            rows.append({"id": ident, "method": method, "path": path, "started_at": started,
                         "status": "ERROR", "error_type": type(error).__name__})
            continue
        with response:
            body = response.read(65536)
            try:
                code = json.loads(body).get("error")
            except (ValueError, AttributeError):
                code = None
            rows.append({"id": ident, "method": method, "path": path, "started_at": started,
                         "expected_http": expected, "actual_http": response.code,
                         "expected_code": expected_code, "actual_code": code,
                         "response_sha256": hashlib.sha256(body).hexdigest(),
                         "status": "PASS" if response.code == expected and code == expected_code else "FAIL"})
    return {"schema_version": 1, "mode": "live-local-http", "target": origin,
            "note": "No login, real model, real funds, or authenticated mutation is performed.", "cases": rows}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    result = run(args.base_url)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    passed = sum(row["status"] == "PASS" for row in result["cases"])
    print(f"{passed}/{len(result['cases'])} HTTP boundary probes passed")
    raise SystemExit(0 if passed == len(result["cases"]) else 1)
