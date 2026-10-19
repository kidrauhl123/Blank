import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./db", () => ({ query: mocks.query, db: {}, withTransaction: vi.fn() }));

import { inspectAgentRun, resumeAgentRuntime } from "./agent-runtime";
import { withPreferenceScope } from "./preference-runtime";

beforeEach(() => { mocks.query.mockReset().mockResolvedValue({ rows: [] }); });

describe("business-agent run visitor binding", () => {
  it("filters task inspection and resume by the current visitor and profile", async () => {
    const scope = { ownerId: "owner-a", profileKey: "demo-a" };
    await withPreferenceScope(scope, async () => {
      expect(await inspectAgentRun("customer-a", "task-a")).toBeNull();
      await expect(resumeAgentRuntime({ customerId: "customer-a", taskId: "task-a", operationId: "operation-a", approved: false })).rejects.toThrow("AGENT_RUN_NOT_FOUND");
    });
    for (const [sql, values] of mocks.query.mock.calls) {
      expect(sql).toContain("memory_owner_id IS NOT DISTINCT FROM");
      expect(sql).toContain("memory_profile_key IS NOT DISTINCT FROM");
      expect(values).toContain(scope.ownerId);
      expect(values).toContain(scope.profileKey);
    }
  });
});
