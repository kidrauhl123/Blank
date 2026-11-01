import { describe, expect, it } from "vitest";
import { FRAUD_HOTLINE, FRAUD_QUESTIONS, decideFraud, scamPhraseIn, type FraudInput } from "./fraud-core";

// 基准：白天、已经转过的老朋友、金额很小、没有话术、10 分钟内没有别人。每个用例只改一个条件。
const base: FraudInput = { newRecipient: false, amountMinor: 10_000, typicalAmountMinor: 10_000, beijingHour: 12, recentOtherRecipients: 0, scamPhrase: null };
const withOverrides = (patch: Partial<FraudInput>): FraudInput => ({ ...base, ...patch });

describe("decideFraud 什么时候暂缓", () => {
  it("正常转给老朋友：不暂缓，也不给原因", () => {
    expect(decideFraud(base)).toEqual({ hold: false, reasons: [] });
  });

  it("第一次转给这个人、金额正常、白天：不暂缓", () => {
    expect(decideFraud(withOverrides({ newRecipient: true }))).toEqual({ hold: false, reasons: [] });
  });

  it("第一次转给这个人、没有历史、金额达到 ¥2,000：暂缓，并说明两个原因", () => {
    const decision = decideFraud(withOverrides({ newRecipient: true, amountMinor: 200_000, typicalAmountMinor: null }));
    expect(decision.hold).toBe(true);
    expect(decision.reasons.map(reason => reason.code)).toEqual(["NEW_RECIPIENT", "UNUSUAL_AMOUNT"]);
  });

  it("金额是平时平均额的 3 倍（且不少于 ¥2,000）才算异常；2 倍不算", () => {
    const twice = decideFraud(withOverrides({ newRecipient: true, amountMinor: 300_000, typicalAmountMinor: 150_000 }));
    expect(twice.reasons.map(reason => reason.code)).not.toContain("UNUSUAL_AMOUNT");
    expect(twice.hold).toBe(false);
    const thrice = decideFraud(withOverrides({ newRecipient: true, amountMinor: 300_000, typicalAmountMinor: 100_000 }));
    expect(thrice.hold).toBe(true);
    expect(thrice.reasons.map(reason => reason.code)).toContain("UNUSUAL_AMOUNT");
  });

  it("金额再大，如果是老朋友也不因为金额暂缓（异常金额只在第一次转给这个人时才看）", () => {
    expect(decideFraud(withOverrides({ amountMinor: 900_000, typicalAmountMinor: null }))).toEqual({ hold: false, reasons: [] });
  });

  it.each([23, 0, 3, 6])("第一次转给这个人，北京时间 %i 点（深夜）：暂缓，原因是深夜", hour => {
    const decision = decideFraud(withOverrides({ newRecipient: true, beijingHour: hour }));
    expect(decision.hold).toBe(true);
    expect(decision.reasons.map(reason => reason.code)).toContain("NIGHT");
  });

  it.each([7, 12, 22])("北京时间 %i 点不算深夜", hour => {
    expect(decideFraud(withOverrides({ newRecipient: true, beijingHour: hour })).hold).toBe(false);
  });

  it("命中诈骗话术：不管收款人是谁、金额多少，都暂缓", () => {
    const decision = decideFraud(withOverrides({ scamPhrase: "安全账户" }));
    expect(decision.hold).toBe(true);
    expect(decision.reasons).toEqual([expect.objectContaining({ code: "SCAM_PHRASE", text: expect.stringContaining("安全账户") })]);
  });

  it("10 分钟内转给过别的人，这一位又是第一次：暂缓（连续转给陌生人）", () => {
    const decision = decideFraud(withOverrides({ newRecipient: true, recentOtherRecipients: 1 }));
    expect(decision.hold).toBe(true);
    expect(decision.reasons.map(reason => reason.code)).toContain("BURST_NEW_RECIPIENTS");
  });

  it("连续转账的条件只对第一次转给这个人才成立：老朋友不因为这个暂缓", () => {
    expect(decideFraud(withOverrides({ recentOtherRecipients: 3 })).hold).toBe(false);
  });
});

describe("scamPhraseIn 话术命中", () => {
  it("包含话术就返回命中的那一个", () => {
    expect(scamPhraseIn("请把钱转到安全账户")).toBe("安全账户");
    expect(scamPhraseIn("这是一笔保证金")).toBe("保证金");
  });
  it("普通的话、空值都不命中", () => {
    expect(scamPhraseIn("给小橘子转 100 元")).toBeNull();
    expect(scamPhraseIn("")).toBeNull();
    expect(scamPhraseIn(null)).toBeNull();
    expect(scamPhraseIn(undefined)).toBeNull();
  });
});

describe("拦截卡的固定文字", () => {
  it("三个关键问题、96110 专线", () => {
    expect(FRAUD_QUESTIONS).toHaveLength(3);
    expect(FRAUD_HOTLINE).toContain("96110");
  });
});
