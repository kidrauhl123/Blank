import { describe, expect, it } from "vitest";
import { FRAUD_HOTLINE, decideFraud, scamPhraseWarning, type FraudInput } from "./fraud-core";

// 一笔没有任何可疑信号的转账作为基线：老收款人、白天、金额正常、没有话术、没有新设备。
const base: FraudInput = { newRecipient: false, amountMinor: 300_000, typicalAmountMinor: 250_000, beijingHour: 12, recentOtherRecipients: 0, scamPhrase: null };

describe("新设备登录后的大额转账", () => {
  it("刚从新设备登录（24 小时内）又转出大额：暂缓，并说明原因", () => {
    const decision = decideFraud({ ...base, newDevice: true });
    expect(decision.hold).toBe(true);
    expect(decision.reasons).toEqual([{ code: "NEW_DEVICE", text: "你刚从一台新设备登录，就要转出大额" }]);
  });

  it("金额不大、或者不是新设备，都不暂缓", () => {
    expect(decideFraud({ ...base, amountMinor: 50_000, typicalAmountMinor: 10_000, newDevice: true }).hold).toBe(false);
    expect(decideFraud({ ...base, newDevice: false }).hold).toBe(false);
    expect(decideFraud(base).hold).toBe(false);
  });
});

describe("对话或 IM 里的诈骗话术提醒", () => {
  it("提醒只引用我们自己的话术词，并给出反诈专线", () => {
    const text = scamPhraseWarning("安全账户");
    expect(text).toContain("“安全账户”");
    expect(text).toContain(FRAUD_HOTLINE);
    expect(text).toContain("不要转账");
  });
});
