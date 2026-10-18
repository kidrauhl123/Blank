import { describe, expect, it } from "vitest";
import { guardQuestion, needsHumanHandoff } from "./app-agent-guards";
import type { AppPage } from "./app-agent-protocol";

describe("page assistant output guards", () => {
  it("replaces invented amount buttons with a free-input route", () => {
    expect(guardQuestion({ type: "question", question: "转账金额是多少？", options: ["100元", "200元"] }, "给小苹果转账"))
      .toEqual({ type: "question", question: "请自行输入具体金额，或暂不办理。", options: ["自行输入", "暂不办理"] });
    expect(guardQuestion({ type: "question", question: "查看哪张卡？", options: ["日常卡", "旅行卡"] }, "看看卡片"))
      .toMatchObject({ options: ["日常卡", "旅行卡"] });
  });

  it("uses a deterministic human handoff message when the model ends after preparing a confirmation page", () => {
    const page: AppPage = { name: "转账确认", version: "v2", text: "核对转账", controls: [
      { id: "confirm", label: "确认转账", kind: "button", permission: "human", disabled: false },
    ] };
    expect(needsHumanHandoff(page, { type: "fill", target: "amount", value: "200", pageVersion: "v1", description: "填写金额" }, "APPLIED")).toBe(true);
    expect(needsHumanHandoff(page, { type: "inspect", description: "查看页面" }, "OBSERVED")).toBe(false);
  });
});
