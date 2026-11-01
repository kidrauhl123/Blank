import { describe, expect, it } from "vitest";
import { planCardAction, type CardRow } from "./card-action";

const cards: CardRow[] = [
  { card_name: "日常卡", masked_no: "6222 **** 1234", status: "ACTIVE", card_type: "VIRTUAL" },
  { card_name: "旅行卡", masked_no: "6222 **** 5678", status: "LOCKED", card_type: "VIRTUAL" },
  { card_name: "备用卡", masked_no: "**** 9999", status: "ACTIVE", card_type: "VIRTUAL" },
];

describe("卡片办理的服务端检查", () => {
  it("挂失暂未支持，明确不能说成锁卡或已挂失", () => {
    const result = planCardAction({ action: "report_loss" }, cards);
    expect(result).toMatchObject({ status: "UNSUPPORTED" });
    expect(JSON.stringify(result)).toContain("锁卡不等于挂失");
  });

  it("申请虚拟卡必须有名称", () => {
    expect(planCardAction({ action: "apply_virtual" }, cards)).toMatchObject({ error: expect.stringContaining("起个名字") });
    expect(planCardAction({ action: "apply_virtual", cardName: "出行卡" }, cards)).toMatchObject({ status: "READY", cardName: "出行卡" });
  });

  it("多张正常卡且没有尾号时让用户选择，不替用户选", () => {
    expect(planCardAction({ action: "lock" }, cards)).toMatchObject({ status: "CHOOSE", cards: [{ name: "日常卡", last4: "1234", status: "正常" }, { name: "备用卡", last4: "9999", status: "正常" }] });
  });

  it("按尾号锁定唯一的正常卡；已锁定的卡直接说明", () => {
    expect(planCardAction({ action: "lock", last4: "1234" }, cards)).toMatchObject({ status: "READY", card: { name: "日常卡", last4: "1234" } });
    expect(planCardAction({ action: "lock", last4: "5678" }, cards)).toMatchObject({ status: "ALREADY_LOCKED" });
  });

  it("找不到的尾号、没有卡片、其他状态的卡都不返回可执行的步骤", () => {
    expect(planCardAction({ action: "lock", last4: "0000" }, cards)).toMatchObject({ error: expect.stringContaining("没有找到") });
    expect(planCardAction({ action: "lock" }, [])).toMatchObject({ error: expect.stringContaining("没有卡片") });
    expect(planCardAction({ action: "lock", last4: "1234" }, [{ ...cards[0], status: "CLOSED" }])).toMatchObject({ error: expect.stringContaining("暂不可锁定") });
  });
});
