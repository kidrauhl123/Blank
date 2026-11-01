import { createHash } from "node:crypto";
import { z } from "zod";
import { DAILY_TRANSFER_RED_THRESHOLD_MINOR } from "./policy";

// 立规矩（Agent 钱包）的确定性核心：模板、硬上限、规矩卡文案、是否在规矩内的判断。
// 全部是纯函数：不碰数据库、不调用模型。模型只能提议参数，参数和每一笔免确认转账都由这里的代码裁决。
export const WALLET_CAPS = {
  perTxnMinor: 50_000,               // 单笔免确认上限 ¥500
  monthlyMinor: 200_000,             // 同一访客全部规矩合计每月上限 ¥2,000
  balanceMinor: 200_000,             // 钱包余额上限 ¥2,000：免确认的钱从这里出，损失封顶
  maxRecipients: 5,
  minRelations: 2,                   // 免确认收款人必须是有过至少 2 次往来的老联系人
  relationWindowDays: 180,
  cooldownMs: 24 * 3_600_000,        // 新规矩 24 小时后才生效
  burstWindowMs: 10 * 60_000, burstLimit: 3, // 10 分钟内已自动转出 3 笔，再来一笔就暂停规矩
  suddenFactor: 2,                   // 单笔超过访客平时均额的 2 倍视为异常
  nightFromHour: 23, nightToHour: 7, // 北京时间：23 点起、次日 7 点前是深夜（含 23，不含 7）
} as const;

export const TEMPLATES = { pay_trusted_small: "小额免确认付款" } as const;
export type TemplateId = keyof typeof TEMPLATES;

// 模型给的参数用“元”的整数，服务端换成分，再按硬上限校验：超限的规矩无法创建。
export const payTrustedSmallInput = z.object({
  template: z.literal("pay_trusted_small"),
  recipients: z.array(z.string().trim().min(1).max(12)).min(1).max(WALLET_CAPS.maxRecipients).describe("免确认的收款人姓名，必须是有过多次往来的老联系人"),
  perTxnYuan: z.number().int().min(1).max(WALLET_CAPS.perTxnMinor / 100).describe("单笔不超过多少元（上限 500）；超过的先问用户"),
  monthlyYuan: z.number().int().min(1).max(WALLET_CAPS.monthlyMinor / 100).describe("每月合计不超过多少元（上限 2000）"),
}).strict().superRefine((input, ctx) => {
  if (input.perTxnYuan > input.monthlyYuan) ctx.addIssue({ code: "custom", message: "单笔上限不能高于每月上限" });
  if (new Set(input.recipients).size !== input.recipients.length) ctx.addIssue({ code: "custom", message: "收款人重复了" });
});

export type RuleStatus = "DRAFT" | "COOLING" | "PAUSED" | "REVOKED" | "DISMISSED";
// recipients 是展示用的姓名（只用于规矩卡文字），recipientIds 才是判断依据。
export type RuleParams = { recipients: string[]; recipientIds: string[]; perTxnMinor: number; monthlyMinor: number };
export function paramsFromInput(input: z.infer<typeof payTrustedSmallInput>, recipientIds: string[]): RuleParams {
  return { recipients: input.recipients, recipientIds, perTxnMinor: input.perTxnYuan * 100, monthlyMinor: input.monthlyYuan * 100 };
}

// 摘要是 Passkey 签名的内容：卡上每一项都要进去（姓名是用户看到的，ID 是判断依据），顺序就是存储时的顺序，
// 字段名写死。改了格式或漏掉一项，已签的规矩就对不上，授权会失败而不是悄悄放行。
export function ruleDigest(template: TemplateId, params: RuleParams): string {
  return createHash("sha256").update(JSON.stringify({ t: template, n: params.recipients, r: params.recipientIds, p: params.perTxnMinor, m: params.monthlyMinor })).digest("hex");
}

export const yuan = (minor: number) => `¥${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(minor / 100)}`;

// 规矩卡：由服务端按结构化参数渲染，不使用模型写的任何文字——所见即所执行。
export function describeRule(template: TemplateId, params: RuleParams) {
  return [
    { label: "类型", value: TEMPLATES[template] },
    { label: "免确认的对象", value: `${params.recipients.join("、")}（有过多次往来的老联系人）` },
    { label: "单笔不超过", value: yuan(params.perTxnMinor) },
    { label: "每月合计不超过", value: yuan(params.monthlyMinor) },
    { label: "钱从哪里出", value: "只从 Blank 钱包里出，不动你的主账户" },
    { label: "超出怎么办", value: "照常先问你，由你本人确认" },
    { label: "什么时候生效", value: "你本人验证后再等 24 小时（冷静期）" },
  ];
}

export type RuleState = { status: RuleStatus; effectiveAt: Date | null };
// 展示和判断共用的状态：冷静期过后才算生效（“生效”只是时间判断，状态仍是 COOLING）。
export function ruleStage(rule: RuleState, now: Date): "DRAFT" | "COOLING" | "ACTIVE" | "PAUSED" | "REVOKED" | "DISMISSED" {
  if (rule.status === "COOLING") return rule.effectiveAt && rule.effectiveAt.getTime() <= now.getTime() ? "ACTIVE" : "COOLING";
  return rule.status;
}

export type RuleTransferCheck = {
  rule: { status: RuleStatus; effectiveAt: Date | null; params: RuleParams };
  now: Date;
  recipientCustomerId: string;
  amountMinor: number;
  ruleMonthPaidMinor: number;        // 本规矩本月已经成功自动转出的合计
  ownerMonthPaidMinor: number;       // 同一访客全部规矩本月已转出合计
  walletBalanceMinor: number;
  dailyTotalMinor: number;           // 付款人当天已成功转出的合计（同 bank-core 的口径）
  ownerRecentCount: number;          // 同一访客最近 10 分钟内自动转出的笔数
  typicalAmountMinor: number | null; // 同一访客最近 30 天自动转出的平均金额；没有历史则 null
  beijingHour: number;               // 0–23，北京时间
};
export type RuleTransferVerdict = { allowed: true } | { allowed: false; pause: boolean; reasons: string[] };

// 逐条检查、原因全部收集：调用方要看到所有不满足的原因，而不是遇到第一条就返回。
// pause 为真表示这笔转账像是异常（金额或频率突变），调用方要暂停这位访客的规矩。
export function evaluateRuleTransfer(input: RuleTransferCheck): RuleTransferVerdict {
  const failed: Array<{ reason: string; pause: boolean }> = [];
  const fail = (reason: string, pause = false) => failed.push({ reason, pause });
  const { params } = input.rule;
  if (ruleStage(input.rule, input.now) !== "ACTIVE") fail("规矩还没生效或已暂停/撤销");
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) fail("金额必须是大于 0 的整数分");
  if (!params.recipientIds.includes(input.recipientCustomerId)) fail("这个人不在规矩的名单里");
  if (input.amountMinor > params.perTxnMinor) fail("超过单笔上限");
  if (input.ruleMonthPaidMinor + input.amountMinor > params.monthlyMinor) fail("本规矩本月额度用完了");
  if (input.ownerMonthPaidMinor + input.amountMinor > WALLET_CAPS.monthlyMinor) fail("全部规矩本月合计已到上限");
  if (input.walletBalanceMinor < input.amountMinor) fail("钱包余额不够，这笔照常由你确认");
  if (input.dailyTotalMinor + input.amountMinor > DAILY_TRANSFER_RED_THRESHOLD_MINOR) fail("今天的转账已较多，这笔照常由你确认");
  if (input.beijingHour >= WALLET_CAPS.nightFromHour || input.beijingHour < WALLET_CAPS.nightToHour) fail("深夜的转账不自动执行，照常由你确认");
  if (input.typicalAmountMinor !== null && input.amountMinor >= input.typicalAmountMinor * WALLET_CAPS.suddenFactor) fail("金额明显高于平时，规矩已暂停，请你本人确认", true);
  if (input.ownerRecentCount >= WALLET_CAPS.burstLimit) fail("10 分钟内自动转出次数过多，规矩已暂停", true);
  if (failed.length === 0) return { allowed: true };
  return { allowed: false, pause: failed.some(item => item.pause), reasons: failed.map(item => item.reason) };
}

// 立规矩的意图只认用户本人在 App 里亲手输入的话：页面内容、备注、商户名、资讯、工具返回里出现的“立规矩”一律不算。
// 这道闸只是纵深防御（挡住页面、备注里的“指令”和语音）；真正的闸门是用户本人的强验证和 24 小时冷静期，所以宁可偶有误放行“提议”，也不能漏掉用户的正常说法。
const RULE_INTENT = /(规矩|规则|免确认|免验证|免密|不用(再|每次|一一)?(问|确认|验证|批)|不需要(我)?(再|每次)?(确认|验证)|别(再|每次)?问我|自动(付|转|还)|授权.{0,6}(付|转|小额))/u;
export const hasRuleIntent = (userText: string) => RULE_INTENT.test(userText);
