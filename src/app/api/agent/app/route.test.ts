import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ start: vi.fn(), session: vi.fn() }));
vi.mock("@/lib/app-session", () => ({ requireAppSession: mocks.session }));
vi.mock("@/lib/visitor-memory", () => ({ resolveVisitorMemoryScope: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/model-settings", () => ({ getSessionModel: vi.fn().mockResolvedValue("selected-test-model") }));
vi.mock("@/lib/app-agent-runtime", () => ({ startAppAgent: mocks.start, getAppAgentRun: vi.fn(), controlAppAgent: vi.fn() }));
import { POST } from "./route";

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("page agent failure response", () => {
  it.each([
    [Object.assign(new Error("private upstream response containing sk-private"), { status: 403 }), 502, "AI_MODEL_ACCESS_DENIED"],
    [new Error("AI_MODEL_NOT_AVAILABLE"), 422, "AI_MODEL_NOT_AVAILABLE"],
  ])("returns a safe, actionable response and logs only classification", async (error, status, code) => {
    mocks.session.mockResolvedValue({ customerId: "test-customer", sessionHash: "test-session" });
    mocks.start.mockRejectedValue(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(new Request("https://bank.example/api/agent/app", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "start", message: "查一下我的余额", page: { name: "测试页", version: "v1", text: "", controls: [] } }),
    }));
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toMatchObject({ error: code });
    expect(body.message).toContain("个人中心 → 设置");
    expect(log).toHaveBeenCalledWith("APP_AGENT_REQUEST_FAILED", expect.objectContaining({ code }));
    expect(JSON.stringify([body, log.mock.calls])).not.toMatch(/sk-private|private upstream|test-session|test-customer/);
  });
});
