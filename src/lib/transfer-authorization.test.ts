import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(), commitTransfer: vi.fn(), commitPreparedCardLock: vi.fn(),
  writeAudit: vi.fn(), resumeAgentRuntime: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
  AuthError: class extends Error {
    constructor(public code: string, public status: number) { super(code); }
  },
}));
vi.mock("@/lib/bank-core", () => ({ commitTransfer: mocks.commitTransfer, commitPreparedCardLock: mocks.commitPreparedCardLock }));
vi.mock("@/lib/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@/lib/agent-runtime", () => ({ resumeAgentRuntime: mocks.resumeAgentRuntime }));

import { POST as commit } from "../app/api/operations/[operationId]/commit/route";
import { POST as authorize } from "../app/api/v1/operations/[operationId]/authorize/route";

const operationId = "TRF-TEST-1";
const customerId = "147d683a-42bb-4f49-a17c-3f0e7a17e75f";
const taskId = "68b63839-422c-4bf7-9d37-f9e814c406d3";
const context = { params: Promise.resolve({ operationId }) };
const routes = [
  { name: "APP Agent commit", handler: commit, path: `/api/operations/${operationId}/commit`, body: { confirmed: true, type: "TRANSFER", taskId } },
  { name: "APP direct authorization", handler: authorize, path: `/api/v1/operations/${operationId}/authorize`, body: { taskId } },
] as const;

function request(path: string, body: unknown) {
  return new Request(`https://bank.example.com${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", origin: "https://bank.example.com", host: "bank.example.com" }, body: JSON.stringify(body),
  });
}

describe.each(routes)("$name authorization boundary", ({ handler, path, body }) => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authenticateRequest.mockResolvedValue({ kind: "SESSION", customerId });
  });

  it("returns persisted red authorization requirements as 409 without reporting success or resuming the Agent", async () => {
    const upgraded = { authError: "AUTH_REQUIRED", operationId, status: "AWAITING_AUTH", riskLevel: "RED", requiredAuth: "MFA", authorizationExpiresAt: "2030-01-01T00:10:00.000Z" };
    mocks.commitTransfer.mockResolvedValue(upgraded);
    const response = await handler(request(path, body), context);
    const result = await response.json();
    expect(response.status).toBe(409);
    expect(result).toMatchObject({ ...upgraded, error: "AUTH_REQUIRED" });
    expect(result.message).toContain("资金未转出");
    expect(result).not.toHaveProperty("receipt");
    expect(result).not.toHaveProperty("alreadyExecuted", true);
    expect(result.agentRuntime).not.toBe("COMPLETED");
    expect(mocks.commitTransfer).toHaveBeenCalledExactlyOnceWith(customerId, operationId, expect.objectContaining({ taskId }));
    expect(mocks.resumeAgentRuntime).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("returns challenge lockout as 423 without resuming the Agent", async () => {
    mocks.commitTransfer.mockResolvedValue({ authError: "AUTH_FUSE_ACTIVE" });
    const response = await handler(request(path, { ...body, totpCode: "000000" }), context);
    expect(response.status).toBe(423);
    expect(await response.json()).toMatchObject({ error: "AUTH_FUSE_ACTIVE" });
    expect(mocks.resumeAgentRuntime).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("keeps an already locked challenge at 423 when the core rejects a retry", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.commitTransfer.mockRejectedValue(new Error("AUTH_FUSE_ACTIVE"));
      const response = await handler(request(path, { ...body, totpCode: "000000" }), context);
      expect(response.status).toBe(423);
      expect(await response.json()).toMatchObject({ error: "AUTH_FUSE_ACTIVE" });
      expect(mocks.resumeAgentRuntime).not.toHaveBeenCalled();
      expect(mocks.writeAudit).not.toHaveBeenCalled();
    } finally { logger.mockRestore(); }
  });
});
