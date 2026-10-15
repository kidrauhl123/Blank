import { describe, expect, it } from "vitest";
import { appAgentFailure } from "./app-agent-errors";

describe("page agent provider failures", () => {
  it.each([
    [401, "AI_MODEL_ACCESS_DENIED", 502], [403, "AI_MODEL_ACCESS_DENIED", 502],
    [402, "AI_MODEL_QUOTA_EXHAUSTED", 503], [429, "AI_MODEL_RATE_LIMIT", 503],
    [408, "AI_MODEL_TIMEOUT", 504], [504, "AI_MODEL_TIMEOUT", 504],
    [400, "AI_MODEL_REQUEST_REJECTED", 502], [404, "AI_MODEL_REQUEST_REJECTED", 502],
    [422, "AI_MODEL_REQUEST_REJECTED", 502], [500, "AI_MODEL_SERVICE_UNAVAILABLE", 503],
    [503, "AI_MODEL_SERVICE_UNAVAILABLE", 503],
  ])("classifies provider status %i without forwarding its diagnostic payload", (status, code, httpStatus) => {
    const provider = Object.assign(new Error("sk-private-upstream-key and private account data"), { status, headers: { authorization: "Bearer secret" } });
    const result = appAgentFailure(new Error("SDK wrapper with private data", { cause: provider }));
    expect(result).toMatchObject({ code, status: httpStatus, upstreamStatus: status });
    expect(JSON.stringify(result)).not.toMatch(/sk-private|private account|SDK wrapper|Bearer|secret/);
  });

  it("gives an actionable model selection message for upstream access denial", () => {
    expect(appAgentFailure({ status: 403 }).message).toContain("个人中心 → 设置");
  });

  it.each(["APIConnectionTimeoutError", "TimeoutError", "AbortError"])("recognizes %s without an HTTP status", name => {
    expect(appAgentFailure(new Error("wrapper", { cause: { name } }))).toMatchObject({ code: "AI_MODEL_TIMEOUT", status: 504 });
  });

  it("retains application errors instead of misclassifying them as provider errors", () => {
    expect(appAgentFailure(Object.assign(new Error("APP_AGENT_CONTROL_REQUIRED"), { status: 403 }))).toMatchObject({ code: "APP_AGENT_CONTROL_REQUIRED", status: 403 });
    expect(appAgentFailure(new Error("AI_MODEL_NOT_AVAILABLE"))).toMatchObject({ code: "AI_MODEL_NOT_AVAILABLE", status: 422 });
  });

  it("bounds cyclic causes and keeps unknown failures generic", () => {
    const error: { cause?: unknown; message: string } = { message: "private details" };
    error.cause = error;
    expect(appAgentFailure(error)).toMatchObject({ code: "APP_AGENT_FAILED", status: 502 });
    expect(appAgentFailure(new Error("constructor"))).toMatchObject({ code: "APP_AGENT_FAILED", status: 502 });
  });
});
