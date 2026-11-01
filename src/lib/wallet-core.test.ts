import { describe, expect, it } from "vitest";
import { DAILY_TRANSFER_RED_THRESHOLD_MINOR } from "./policy";
import {
  WALLET_CAPS,
  describeRule,
  evaluateRuleTransfer,
  hasRuleIntent,
  paramsFromInput,
  payTrustedSmallInput,
  ruleDigest,
  ruleStage,
  type RuleParams,
  type RuleTransferCheck,
} from "./wallet-core";

// 立规矩的纯函数测试：每个拒绝条件都有一个用例证明它真的会拒绝。
// “现在”是北京时间 2026-10-31 上午 10 点；时间都写明 +08:00，免得按运行环境的时区理解。
const NOW = new Date("2026-10-31T10:00:00+08:00");
const YESTERDAY = new Date("2026-10-30T10:00:00+08:00");
const TOMORROW = new Date("2026-11-01T10:00:00+08:00");

const validInput = { template: "pay_trusted_small", recipients: ["小橘子"], perTxnYuan: 100, monthlyYuan: 500 };
const PARAMS: RuleParams = { recipients: ["小橘子"], recipientIds: ["cust_xjz"], perTxnMinor: 10_000, monthlyMinor: 50_000 };

// 基准：过了冷静期的生效规矩，收款人在名单里，各项都在上限内，一笔 ¥30 的付款。
// 每个用例只改一个条件，失败时只出现一条原因，能直接看出是哪条判断出了问题。
// typical 6000 的突发线是 12000，基准金额远低于它，所以基准不会触发突发。
function baseCheck(): RuleTransferCheck {
  return {
    rule: { status: "COOLING", effectiveAt: YESTERDAY, params: PARAMS },
    now: NOW,
    recipientCustomerId: "cust_xjz",
    amountMinor: 3_000,
    ruleMonthPaidMinor: 0,
    ownerMonthPaidMinor: 0,
    walletBalanceMinor: 100_000,
    dailyTotalMinor: 0,
    ownerRecentCount: 0,
    typicalAmountMinor: 6_000,
    beijingHour: 10,
  };
}
const withOverrides = (patch: Partial<RuleTransferCheck>): RuleTransferCheck => ({ ...baseCheck(), ...patch });
const withRule = (patch: Partial<RuleTransferCheck["rule"]>) => withOverrides({ rule: { ...baseCheck().rule, ...patch } });

// 整个判决（是否允许、pause、原因列表）一起断言：原因列表只有这一条，说明别的条件没有误触发。
const expectRefused = (check: RuleTransferCheck, reasons: string[], pause = false) =>
  expect(evaluateRuleTransfer(check)).toEqual({ allowed: false, pause, reasons });
const expectAllowed = (check: RuleTransferCheck) => expect(evaluateRuleTransfer(check)).toEqual({ allowed: true });

describe("WALLET_CAPS", () => {
  // 这些数字就是安全边界。改它们时必须同时改这里，让改动在测试里被看见，而不是悄悄生效。
  it("pins the caps the rules are built on", () => {
    expect(WALLET_CAPS).toMatchObject({
      perTxnMinor: 50_000,
      monthlyMinor: 200_000,
      maxRecipients: 5,
      minRelations: 2,
      cooldownMs: 24 * 3_600_000,
      burstWindowMs: 10 * 60_000,
      burstLimit: 3,
      suddenFactor: 2,
      nightFromHour: 23,
      nightToHour: 7,
    });
  });
});

describe("payTrustedSmallInput", () => {
  it("accepts a legal rule", () => {
    expect(payTrustedSmallInput.safeParse(validInput).success).toBe(true);
  });
  it("accepts the caps exactly: 500 per transaction and 2000 per month", () => {
    expect(payTrustedSmallInput.safeParse({ ...validInput, perTxnYuan: 500, monthlyYuan: 2000 }).success).toBe(true);
  });
  it("accepts a per-transaction limit equal to the monthly limit", () => {
    expect(payTrustedSmallInput.safeParse({ ...validInput, perTxnYuan: 200, monthlyYuan: 200 }).success).toBe(true);
  });
  it("rejects a per-transaction limit above 500 yuan", () => {
    expect(payTrustedSmallInput.safeParse({ ...validInput, perTxnYuan: 501 }).success).toBe(false);
  });
  it("rejects a monthly limit above 2000 yuan", () => {
    expect(payTrustedSmallInput.safeParse({ ...validInput, monthlyYuan: 2001 }).success).toBe(false);
  });
  it("rejects a per-transaction limit above the monthly limit", () => {
    const result = payTrustedSmallInput.safeParse({ ...validInput, perTxnYuan: 300, monthlyYuan: 200 });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(issue => issue.message)).toContain("单笔上限不能高于每月上限");
  });
  it.each([0, -1, 10.5])("rejects a per-transaction limit of %s yuan", perTxnYuan => {
    expect(payTrustedSmallInput.safeParse({ ...validInput, perTxnYuan }).success).toBe(false);
  });
  it.each([0, 2001, 500.5])("rejects a monthly limit of %s yuan", monthlyYuan => {
    expect(payTrustedSmallInput.safeParse({ ...validInput, monthlyYuan }).success).toBe(false);
  });
  it("accepts exactly 5 recipients and rejects 6", () => {
    expect(payTrustedSmallInput.safeParse({ ...validInput, recipients: ["甲", "乙", "丙", "丁", "戊"] }).success).toBe(true);
    expect(payTrustedSmallInput.safeParse({ ...validInput, recipients: ["甲", "乙", "丙", "丁", "戊", "己"] }).success).toBe(false);
  });
  it("rejects an empty recipient list", () => {
    expect(payTrustedSmallInput.safeParse({ ...validInput, recipients: [] }).success).toBe(false);
  });
  it("rejects duplicate recipients", () => {
    const result = payTrustedSmallInput.safeParse({ ...validInput, recipients: ["小橘子", "小橘子"] });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(issue => issue.message)).toContain("收款人重复了");
  });
  it("rejects blank recipient names, including whitespace only", () => {
    expect(payTrustedSmallInput.safeParse({ ...validInput, recipients: [""] }).success).toBe(false);
    expect(payTrustedSmallInput.safeParse({ ...validInput, recipients: ["   "] }).success).toBe(false);
  });
  it("accepts a 12-character recipient name and rejects 13", () => {
    expect(payTrustedSmallInput.safeParse({ ...validInput, recipients: ["一".repeat(12)] }).success).toBe(true);
    expect(payTrustedSmallInput.safeParse({ ...validInput, recipients: ["一".repeat(13)] }).success).toBe(false);
  });
  it("rejects unknown extra fields (strict)", () => {
    expect(payTrustedSmallInput.safeParse({ ...validInput, autoApprove: true }).success).toBe(false);
  });
  it("rejects any template other than pay_trusted_small", () => {
    expect(payTrustedSmallInput.safeParse({ ...validInput, template: "pay_anyone" }).success).toBe(false);
  });
});

describe("paramsFromInput", () => {
  it("converts yuan to fen and keeps the recipient names and IDs as given", () => {
    const input = payTrustedSmallInput.parse({ ...validInput, recipients: ["小橘子", "大橘子"] });
    expect(paramsFromInput(input, ["cust_a", "cust_b"])).toEqual({
      recipients: ["小橘子", "大橘子"],
      recipientIds: ["cust_a", "cust_b"],
      perTxnMinor: 10_000,
      monthlyMinor: 50_000,
    });
  });
});

describe("ruleDigest", () => {
  it("is the same for the same rule", () => {
    expect(ruleDigest("pay_trusted_small", PARAMS)).toBe(ruleDigest("pay_trusted_small", { ...PARAMS }));
  });
  it("is a 64-character lowercase hex string", () => {
    expect(ruleDigest("pay_trusted_small", PARAMS)).toMatch(/^[0-9a-f]{64}$/);
  });
  // 摘要是 Passkey 签名的内容。卡上每一项都必须进去：漏掉一项的话，改了这一项，旧签名仍能通过校验。
  it.each<[string, Partial<RuleParams>]>([
    ["recipient name", { recipients: ["大橘子"] }],
    ["recipient ID", { recipientIds: ["cust_other"] }],
    ["per-transaction limit", { perTxnMinor: 20_000 }],
    ["monthly limit", { monthlyMinor: 100_000 }],
  ])("changes when the %s changes", (_field, patch) => {
    expect(ruleDigest("pay_trusted_small", { ...PARAMS, ...patch })).not.toBe(ruleDigest("pay_trusted_small", PARAMS));
  });
});

describe("describeRule", () => {
  const TWO_RECIPIENTS: RuleParams = { ...PARAMS, recipients: ["小橘子", "大橘子"], recipientIds: ["cust_a", "cust_b"] };
  const valueOf = (params: RuleParams, label: string) =>
    describeRule("pay_trusted_small", params).find(line => line.label === label)?.value;

  it("names every recipient, marked as established contacts", () => {
    expect(valueOf(TWO_RECIPIENTS, "免确认的对象")).toBe("小橘子、大橘子（有过多次往来的老联系人）");
  });
  it("shows the template name", () => {
    expect(valueOf(PARAMS, "类型")).toBe("小额免确认付款");
  });
  it("shows the per-transaction and monthly limits in yuan() format", () => {
    expect(valueOf(PARAMS, "单笔不超过")).toBe("¥100");
    expect(valueOf(PARAMS, "每月合计不超过")).toBe("¥500");
    expect(valueOf({ ...PARAMS, monthlyMinor: 200_000 }, "每月合计不超过")).toBe("¥2,000");
  });
  it("says the money comes only from the Blank wallet, not the main account", () => {
    expect(valueOf(PARAMS, "钱从哪里出")).toBe("只从 Blank 钱包里出，不动你的主账户");
  });
  it("states the cooling period in the same hours as WALLET_CAPS.cooldownMs", () => {
    expect(valueOf(PARAMS, "什么时候生效")).toContain(`${WALLET_CAPS.cooldownMs / 3_600_000} 小时`);
  });
  it("never shows the old product names", () => {
    const text = describeRule("pay_trusted_small", PARAMS).map(line => `${line.label}${line.value}`).join("");
    for (const retired of ["BankPilot", "留白", "AI 助手"]) expect(text).not.toContain(retired);
  });
});

describe("ruleStage", () => {
  it.each(["DRAFT", "PAUSED", "REVOKED", "DISMISSED"] as const)("returns %s unchanged even after effectiveAt has passed", status => {
    expect(ruleStage({ status, effectiveAt: YESTERDAY }, NOW)).toBe(status);
  });
  it("turns COOLING into ACTIVE once effectiveAt has passed", () => {
    expect(ruleStage({ status: "COOLING", effectiveAt: YESTERDAY }, NOW)).toBe("ACTIVE");
  });
  it("treats effectiveAt exactly equal to now as ACTIVE", () => {
    expect(ruleStage({ status: "COOLING", effectiveAt: NOW }, NOW)).toBe("ACTIVE");
  });
  it("stays COOLING until effectiveAt", () => {
    expect(ruleStage({ status: "COOLING", effectiveAt: TOMORROW }, NOW)).toBe("COOLING");
  });
  it("stays COOLING when effectiveAt is missing", () => {
    expect(ruleStage({ status: "COOLING", effectiveAt: null }, NOW)).toBe("COOLING");
  });
});

describe("evaluateRuleTransfer", () => {
  it("allows a payment that satisfies every condition", () => {
    expectAllowed(baseCheck());
  });

  describe("rule stage and recipient", () => {
    it("refuses before the cooling period ends, without pausing", () => {
      expectRefused(withRule({ effectiveAt: TOMORROW }), ["规矩还没生效或已暂停/撤销"]);
    });
    it("refuses a COOLING rule with no effectiveAt", () => {
      expectRefused(withRule({ effectiveAt: null }), ["规矩还没生效或已暂停/撤销"]);
    });
    it.each(["DRAFT", "PAUSED", "REVOKED", "DISMISSED"] as const)("refuses a %s rule even after effectiveAt has passed", status => {
      expectRefused(withRule({ status, effectiveAt: YESTERDAY }), ["规矩还没生效或已暂停/撤销"]);
    });
    it("refuses a recipient who is not on the rule's list", () => {
      expectRefused(withOverrides({ recipientCustomerId: "cust_other" }), ["这个人不在规矩的名单里"]);
    });
  });

  describe("limits", () => {
    it.each([0, -100, 1.5, Number.NaN])("refuses amount %s, which is not a positive whole fen", amountMinor => {
      expectRefused(withOverrides({ amountMinor }), ["金额必须是大于 0 的整数分"]);
    });
    it("allows an amount exactly at the per-transaction limit", () => {
      expectAllowed(withOverrides({ amountMinor: 10_000 }));
    });
    it("refuses an amount one fen over the per-transaction limit", () => {
      expectRefused(withOverrides({ amountMinor: 10_001 }), ["超过单笔上限"]);
    });
    it("allows the rule's monthly total exactly at its limit", () => {
      expectAllowed(withOverrides({ ruleMonthPaidMinor: 47_000, ownerMonthPaidMinor: 47_000 }));
    });
    it("refuses when the rule's monthly total would go over its limit", () => {
      expectRefused(withOverrides({ ruleMonthPaidMinor: 47_001, ownerMonthPaidMinor: 47_001 }), ["本规矩本月额度用完了"]);
    });
    it("allows all rules' monthly total exactly at the global cap", () => {
      expectAllowed(withOverrides({ ownerMonthPaidMinor: WALLET_CAPS.monthlyMinor - 3_000 }));
    });
    it("refuses when all rules' monthly total would go over the global cap", () => {
      expectRefused(withOverrides({ ownerMonthPaidMinor: WALLET_CAPS.monthlyMinor - 2_999 }), ["全部规矩本月合计已到上限"]);
    });
  });

  describe("wallet and daily total", () => {
    it("allows a payment equal to the wallet balance", () => {
      expectAllowed(withOverrides({ walletBalanceMinor: 3_000 }));
    });
    it("refuses when the wallet balance is short", () => {
      expectRefused(withOverrides({ walletBalanceMinor: 2_999 }), ["钱包余额不够，这笔照常由你确认"]);
    });
    it("allows a day's total exactly at the daily red threshold", () => {
      expectAllowed(withOverrides({ dailyTotalMinor: DAILY_TRANSFER_RED_THRESHOLD_MINOR - 3_000 }));
    });
    it("refuses when the day's total would go over the daily red threshold", () => {
      expectRefused(withOverrides({ dailyTotalMinor: DAILY_TRANSFER_RED_THRESHOLD_MINOR - 2_999 }), ["今天的转账已较多，这笔照常由你确认"]);
    });
  });

  describe("night", () => {
    it.each<[number, string]>([
      [0, "2026-11-01T00:30:00+08:00"],
      [6, "2026-11-01T06:30:00+08:00"],
      [23, "2026-10-31T23:30:00+08:00"],
    ])("refuses at Beijing hour %i, without pausing the rule", (beijingHour, at) => {
      expectRefused(withOverrides({ beijingHour, now: new Date(at) }), ["深夜的转账不自动执行，照常由你确认"]);
    });
    it.each<[number, string]>([
      [7, "2026-11-01T07:00:00+08:00"],
      [22, "2026-10-31T22:00:00+08:00"],
    ])("allows at Beijing hour %i, on the edge of the night window", (beijingHour, at) => {
      expectAllowed(withOverrides({ beijingHour, now: new Date(at) }));
    });
  });

  describe("pause conditions", () => {
    // typical 3000 的 2 倍是 6000；9000 超过它，但仍在单笔上限 10000 内，所以只触发突发这一条
    it("refuses and pauses when the amount is over 2x the typical amount", () => {
      expectRefused(withOverrides({ typicalAmountMinor: 3_000, amountMinor: 9_000 }), ["金额明显高于平时，规矩已暂停，请你本人确认"], true);
    });
    it("refuses and pauses at exactly 2x the typical amount (spec says 达到, i.e. reaches)", () => {
      expectRefused(withOverrides({ typicalAmountMinor: 3_000, amountMinor: 6_000 }), ["金额明显高于平时，规矩已暂停，请你本人确认"], true);
    });
    it("skips the sudden check when there is no history (typicalAmountMinor is null)", () => {
      expectAllowed(withOverrides({ typicalAmountMinor: null, amountMinor: 9_000 }));
    });
    it("refuses and pauses when 3 automatic transfers already happened in the last 10 minutes", () => {
      expectRefused(withOverrides({ ownerRecentCount: WALLET_CAPS.burstLimit }), ["10 分钟内自动转出次数过多，规矩已暂停"], true);
    });
    it("allows the third transfer in 10 minutes when only 2 happened before", () => {
      expectAllowed(withOverrides({ ownerRecentCount: WALLET_CAPS.burstLimit - 1 }));
    });
  });

  describe("reasons", () => {
    it("lists every failing condition, not just the first one", () => {
      expectRefused(withOverrides({ recipientCustomerId: "cust_other", amountMinor: 11_000, walletBalanceMinor: 1_000, beijingHour: 23 }), [
        "这个人不在规矩的名单里",
        "超过单笔上限",
        "钱包余额不够，这笔照常由你确认",
        "深夜的转账不自动执行，照常由你确认",
      ]);
    });
    it("pauses if any failing condition is a pause condition, even mixed with ordinary refusals", () => {
      expectRefused(withOverrides({ typicalAmountMinor: 3_000, amountMinor: 9_000, beijingHour: 23 }), [
        "深夜的转账不自动执行，照常由你确认",
        "金额明显高于平时，规矩已暂停，请你本人确认",
      ], true);
    });
  });
});

describe("hasRuleIntent", () => {
  it.each([
    "以后给小橘子 100 块以内的转账不用问我",
    "别问我了，小橘子的钱直接转",
    "以后每次都不用再确认了",
    "不需要我每次确认",
    "免验证付款",
    "帮我立一条规矩",
    "设个规则，小额免确认",
    "免密付款给小橘子",
    "自动付款给小橘子",
    "自动还小苹果 AA",
    "授权小额付款",
    "授权给小橘子付款",
  ])("is true for rule-making wording: %s", text => {
    expect(hasRuleIntent(text)).toBe(true);
  });

  it.each([
    "给小橘子转 100 元",
    "查一下我的余额",
    "把上个月的账单发给我",
    "帮我授权一下登录",
  ])("is false for ordinary requests: %s", text => {
    expect(hasRuleIntent(text)).toBe(false);
  });
});
