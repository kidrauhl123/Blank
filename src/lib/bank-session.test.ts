import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock("./db", () => ({ query: mocks.query, withTransaction: mocks.withTransaction }));

import { AuthError, authenticateRequest, SESSION_COOKIE } from "./auth";
import { assertChannelAdapterRequest } from "./channels";
import { assertSameOrigin } from "./http";
import { requireAppSession } from "./app-session";
import { createHash } from "node:crypto";

const customerId = "147d683a-42bb-4f49-a17c-3f0e7a17e75f";
const session = `${SESSION_COOKIE}=test-session-token`;
const authorizationValues = ["Bearer external-token", "Basic dXNlcjpwYXNz", "", "bearer external-token", "BEARER external-token", "Bearer", "external-token"];

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BANKPILOT_PUBLIC_URL", "https://bank.example.com/bank-path");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("bank session authentication", () => {
  it("uses the same cookie value for authentication, settings and task ownership when cookie names repeat", async () => {
    mocks.query.mockResolvedValue({ rows: [{ customer_id: customerId }], rowCount: 1 });
    const identity = await requireAppSession(new Request("https://bank.example.com/api/agent/app", {
      headers: { cookie: `${SESSION_COOKIE}=first; ${SESSION_COOKIE}=last` },
    }));
    const tokenHash = createHash("sha256").update("last").digest("hex");
    expect(mocks.query.mock.calls[0][1]).toEqual([tokenHash]);
    expect(identity).toEqual({ customerId, sessionTokenHash: tokenHash, sessionHash: createHash("sha256").update(`${SESSION_COOKIE}=last`).digest("hex") });
  });
  for (const cookie of [undefined, session]) {
    it.each(authorizationValues)(`rejects Authorization %j ${cookie ? "even with a valid session cookie" : "without a cookie"} before reading any database identity`, async authorization => {
      mocks.query.mockResolvedValue({ rows: [{ customer_id: customerId }], rowCount: 1 });
      const headers = new Headers({ authorization });
      if (cookie) headers.set("cookie", cookie);
      await expect(authenticateRequest(new Request("https://bank.example.com/api/bootstrap", { headers })))
        .rejects.toMatchObject({ code: "BANK_APP_SESSION_REQUIRED", status: 403 });
      expect(mocks.query).not.toHaveBeenCalled();
      expect(mocks.withTransaction).not.toHaveBeenCalled();
    });
  }

  it("authenticates a valid session using only user_sessions and exposes no external token principal", async () => {
    mocks.query.mockResolvedValue({ rows: [{ customer_id: customerId }], rowCount: 1 });
    expect(await authenticateRequest(new Request("https://bank.example.com/api/bootstrap", { headers: { cookie: session } })))
      .toEqual({ customerId, kind: "SESSION" });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [sql, values] = mocks.query.mock.calls[0];
    expect(sql).toContain("UPDATE user_sessions");
    expect(sql).toContain("s.revoked_at IS NULL");
    expect(sql).toContain("s.expires_at>now()");
    expect(sql).toContain("c.status='ACTIVE'");
    expect(sql).not.toMatch(/api_tokens|api_clients/);
    expect(values).toHaveLength(1);
    expect(values[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(values[0]).not.toBe("test-session-token");
  });

  it.each([undefined, "unrelated_cookie=value"])("rejects a missing session cookie %j without querying the database", async cookie => {
    const headers = cookie ? { cookie } : undefined;
    await expect(authenticateRequest(new Request("https://bank.example.com/api/bootstrap", { headers })))
      .rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED", status: 401 });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects an expired or revoked session rather than using another identity", async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(authenticateRequest(new Request("https://bank.example.com/api/bootstrap", { headers: { cookie: session } })))
      .rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 401 });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});

describe("bank APP same-origin boundary", () => {
  function request(method: string, headers: HeadersInit = {}, url = "https://bank.example.com/api/v1/transfers/prepare") {
    return new Request(url, { method, headers });
  }
  function rejected(request: Request, code: string) {
    try { assertSameOrigin(request); }
    catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect(error).toMatchObject({ code, status: 403 });
      return;
    }
    throw new Error("Expected the request to be rejected");
  }

  it.each(["POST", "PUT", "PATCH", "DELETE"])("requires an Origin for %s", method => {
    rejected(request(method), "INVALID_ORIGIN");
  });

  it.each(["null", "not-a-url", "https://evil.example", "https://bank.example.com.evil", "http://bank.example.com", "https://bank.example.com:444"])
    ("rejects untrusted or malformed Origin %j", origin => {
      rejected(request("POST", { origin }), "INVALID_ORIGIN");
    });

  it("cannot be redirected to a foreign origin by x-forwarded-host or Host", () => {
    rejected(request("POST", { origin: "https://evil.example", "x-forwarded-host": "evil.example", host: "evil.example" }), "INVALID_ORIGIN");
  });

  it("uses the configured public origin over an internal proxy URL and ignores forged forwarding headers", () => {
    expect(() => assertSameOrigin(request("POST", { origin: "https://bank.example.com", "x-forwarded-host": "evil.example" }, "http://127.0.0.1:3000/api/v1/transfers/prepare"))).not.toThrow();
    rejected(request("POST", { origin: "http://127.0.0.1:3000" }, "http://127.0.0.1:3000/api/v1/transfers/prepare"), "INVALID_ORIGIN");
  });

  it("uses the request URL origin in development when no public origin is configured", () => {
    vi.stubEnv("BANKPILOT_PUBLIC_URL", undefined);
    expect(() => assertSameOrigin(request("POST", { origin: "http://localhost:3109" }, "http://localhost:3109/api/v1/transfers/prepare"))).not.toThrow();
    rejected(request("POST", { origin: "http://localhost:3110" }, "http://localhost:3109/api/v1/transfers/prepare"), "INVALID_ORIGIN");
  });

  it.each(["GET", "HEAD"])("allows %s without Origin while still rejecting a supplied foreign Origin", method => {
    expect(() => assertSameOrigin(request(method))).not.toThrow();
    rejected(request(method, { origin: "https://evil.example" }), "INVALID_ORIGIN");
  });

  it.each(authorizationValues)("rejects Authorization %j before same-origin validation on bank reads and writes", authorization => {
    for (const method of ["GET", "POST"]) {
      rejected(request(method, { authorization, cookie: session, origin: "https://bank.example.com" }), "BANK_APP_SESSION_REQUIRED");
    }
  });
});

describe.each(["QQ", "WECOM"] as const)("%s official adapter authentication", channel => {
  const tokens = { QQ: "qq-adapter-test-only", WECOM: "wecom-adapter-test-only" };
  const otherChannel = channel === "QQ" ? "WECOM" : "QQ";
  beforeEach(() => {
    vi.stubEnv("QQ_ADAPTER_TOKEN", tokens.QQ);
    vi.stubEnv("WECOM_ADAPTER_TOKEN", tokens.WECOM);
  });
  function request(headers: HeadersInit = {}) {
    return new Request(`https://bank.example.com/api/channels/${channel.toLowerCase()}/message`, { method: "POST", headers });
  }
  function rejected(headers: HeadersInit, code = "INVALID_CHANNEL_ADAPTER_TOKEN", status = 401) {
    try { assertChannelAdapterRequest(request(headers), channel); }
    catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect(error).toMatchObject({ code, status });
      expect(mocks.query).not.toHaveBeenCalled();
      return;
    }
    throw new Error("Expected official adapter credentials to be rejected");
  }

  it("accepts its own adapter credential without requiring bank cookies or an Origin", () => {
    expect(() => assertChannelAdapterRequest(request({ authorization: `Bearer ${tokens[channel]}` }), channel)).not.toThrow();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("rejects missing and incorrect credentials", () => {
    rejected({});
    rejected({ authorization: "Bearer wrong-short-token" });
    rejected({ authorization: `Bearer ${tokens[channel].slice(0, -1)}x` });
  });
  it("rejects the other official channel's adapter credential", () => {
    rejected({ authorization: `Bearer ${tokens[otherChannel]}` });
  });
  it("does not accept a bank session cookie in place of adapter credentials", () => {
    rejected({ cookie: session, origin: "https://bank.example.com" });
  });
  it("fails closed with 503 when that channel has no configured adapter token", () => {
    vi.stubEnv(`${channel}_ADAPTER_TOKEN`, undefined);
    rejected({ authorization: `Bearer ${tokens[channel]}` }, "CHANNEL_ADAPTER_NOT_CONFIGURED", 503);
  });
});
