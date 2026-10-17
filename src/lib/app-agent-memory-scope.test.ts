import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./db", () => ({ query: mocks.query, db: {}, withTransaction: vi.fn() }));

import { getAppAgentRun } from "./app-agent-runtime";
import { withPreferenceScope } from "./preference-runtime";

const identity = { customerId: "demo-customer", sessionHash: "bank-session" };
const run = { id: "run-a", model: "test-model", status: "COMPLETED", message: "完成", pending: null,
  controlGranted: false, steps: 1, expires_at: new Date(Date.now() + 60_000), memory_owner_id: "owner-a", memory_profile_key: "demo-a" };

beforeEach(() => { mocks.query.mockReset().mockResolvedValue({ rows: [run] }); });

describe("page-agent run visitor binding", () => {
  it("allows the original visitor and rejects a switched browser or profile", async () => {
    expect(await withPreferenceScope({ ownerId: "owner-a", profileKey: "demo-a" }, () => getAppAgentRun(identity, "run-a"))).toMatchObject({ id: "run-a" });
    await expect(withPreferenceScope({ ownerId: "owner-b", profileKey: "demo-a" }, () => getAppAgentRun(identity, "run-a"))).rejects.toThrow("APP_AGENT_NOT_FOUND");
    await expect(withPreferenceScope({ ownerId: "owner-a", profileKey: "demo-b" }, () => getAppAgentRun(identity, "run-a"))).rejects.toThrow("APP_AGENT_NOT_FOUND");
    await expect(getAppAgentRun(identity, "run-a")).rejects.toThrow("APP_AGENT_NOT_FOUND");
  });
});
