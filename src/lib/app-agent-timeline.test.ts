import { describe, expect, it } from "vitest";
import { mapAppAgentTimeline, type AppAgentAuditEvent } from "./app-agent-timeline";

const row = (event_type: string, evidence: unknown): AppAgentAuditEvent =>
  ({ id: crypto.randomUUID(), event_type, evidence, created_at: "2026-10-17T00:00:00Z" });

describe("visible app-agent timeline", () => {
  it("shows handoff and browser reports without claiming a transfer succeeded", () => {
    const events = mapAppAgentTimeline([
      row("APP_AGENT_STARTED", {}),
      row("APP_AGENT_STEP", { status: "ACTION", toolAction: "fill", value: "123456", message: "验证码 123456" }),
      row("APP_AGENT_OBSERVATION", { reportedStatus: "APPLIED", message: "转账成功", value: "123456" }),
      row("APP_AGENT_STEP", { status: "HANDOFF", toolAction: "handoff", description: "收款人 张三 123456" }),
    ]);
    expect(events.map((event) => event.state)).toEqual(["done", "running", "done", "waiting"]);
    expect(JSON.stringify(events)).not.toMatch(/123456|转账成功|张三/);
    expect(events.at(-1)?.title).toBe("等待本人操作");
  });

  it("marks an assistant completion as a conversation end rather than a bank receipt", () => {
    const event = mapAppAgentTimeline([row("APP_AGENT_STEP", { status: "COMPLETED" })])[0];
    expect(event.title).toBe("助手本轮结束");
    expect(event.detail).toContain("不代表银行业务已执行");
  });
});
