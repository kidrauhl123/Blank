// 反诈守护的确定性核心：话术、信号、是否暂缓、拦截卡上的文字和问题。全部是纯函数，不碰数据库、不调用模型。
// 原因和问题都是服务端写死的，对话内容只能命中话术，不能改写这里的任何文字。
// 宁可多问一句，不替用户做决定：暂缓不等于锁死。用户可以强验证继续，也可以选 24 小时冷静期。

export const FRAUD_CAPS = {
  newRecipientWindowMs: 10 * 60_000, // 10 分钟内转给过别的人
  unusualFactor: 3, // 金额达到平时平均额的 3 倍
  unusualMinMinor: 200_000, // 且不少于 ¥2,000（没有历史时直接按这个数判断）
  nightFromHour: 23, // 北京时间深夜：23 点起
  nightToHour: 7, // 到次日 7 点前
  scamLookbackMs: 60 * 60_000, // 最近 1 小时的对话里出现话术
  holdMs: 24 * 3_600_000, // “24 小时后再办”的冷静期
} as const;

// 常见诈骗话术。只做命中，不做语义判断；命中后也只会要求强验证，不会锁定资金。
export const SCAM_PHRASES = ["安全账户", "保证金", "刷单", "验证码", "洗钱", "涉嫌", "公安", "冻结"] as const;
export function scamPhraseIn(text: string | null | undefined): string | null {
  if (!text) return null;
  return SCAM_PHRASES.find(phrase => text.includes(phrase)) ?? null;
}

export type FraudCode = "SCAM_PHRASE" | "NEW_RECIPIENT" | "UNUSUAL_AMOUNT" | "NIGHT" | "BURST_NEW_RECIPIENTS" | "NEW_DEVICE";
export type FraudInput = {
  newRecipient: boolean; // 这位收款人以前没有成功收过这个客户的钱
  amountMinor: number;
  typicalAmountMinor: number | null; // 最近 90 天成功转账的平均额；没有历史则 null
  beijingHour: number; // 0–23
  recentOtherRecipients: number; // 最近 10 分钟内转给过的其他收款人数量（不含这一位）
  scamPhrase: string | null; // 备注或最近对话里命中的话术
  newDevice?: boolean; // 这个会话是新设备登录，并且还在登录后的 24 小时内
};
export type FraudReason = { code: FraudCode; text: string };
export type FraudDecision = { hold: boolean; reasons: FraudReason[] };

// 暂缓的条件（任一满足）：
// 1. 命中诈骗话术；
// 2. 第一次转给这个人，并且金额异常或在深夜；
// 3. 第一次转给这个人，并且 10 分钟内还转给过别的人（连续转给陌生人）。
// 不满足时不返回原因：正常的转账不打扰用户。
export function decideFraud(input: FraudInput): FraudDecision {
  const unusual = input.amountMinor >= FRAUD_CAPS.unusualMinMinor
    && (input.typicalAmountMinor === null || input.amountMinor >= input.typicalAmountMinor * FRAUD_CAPS.unusualFactor);
  const night = input.beijingHour >= FRAUD_CAPS.nightFromHour || input.beijingHour < FRAUD_CAPS.nightToHour;
  const scam = input.scamPhrase !== null;
  const burst = input.newRecipient && input.recentOtherRecipients >= 1;
  // 新设备登录后马上转出大额（不论收款人是谁）：和其他暂缓一样，只要求更强的确认，不锁死资金。
  const newDeviceLarge = input.newDevice === true && input.amountMinor >= FRAUD_CAPS.unusualMinMinor;
  const hold = scam || burst || newDeviceLarge || (input.newRecipient && (unusual || night));
  if (!hold) return { hold: false, reasons: [] };

  const reasons: FraudReason[] = [];
  if (scam) reasons.push({ code: "SCAM_PHRASE", text: `最近的对话或备注里出现了“${input.scamPhrase}”，这类话常见于诈骗` });
  if (input.newRecipient) reasons.push({ code: "NEW_RECIPIENT", text: "这是你第一次转给这个人" });
  if (input.newRecipient && unusual) reasons.push({ code: "UNUSUAL_AMOUNT", text: "这笔金额明显高于你平时的转账" });
  if (input.newRecipient && night) reasons.push({ code: "NIGHT", text: "现在是深夜，又是第一次转给这个人" });
  if (burst) reasons.push({ code: "BURST_NEW_RECIPIENTS", text: "最近十分钟里你还转给过别的人，这一位又是第一次" });
  if (newDeviceLarge) reasons.push({ code: "NEW_DEVICE", text: "你刚从一台新设备登录，就要转出大额" });
  return { hold, reasons };
}

// 陌生小额“退款/返利”入账的提醒：金额不超过 300 元、名字或分类里有退款等字眼、这个商户之前没有和这位客户有过往来。
export const INBOUND_ALERT_CAPS = { maxAmountMinor: 30_000, lookbackMs: 3 * 86_400_000 } as const;
export const REFUND_PATTERN = "退款|返利|返现|退回|赔付|补偿";

// 对话或 IM 里出现诈骗话术时的提醒文字：只引用我们自己的话术词，不复述用户说的其他内容。
export function scamPhraseWarning(phrase: string) {
  return `提醒：你刚才的话里有“${phrase}”，这类话常见于诈骗。请不要转账，也不要告诉任何人验证码。有疑问请拨打 ${FRAUD_HOTLINE}。`;
}

// 拦截卡上的三个关键问题：固定文字，选项由用户自己选，不作为判断依据（判断已经在上面完成了）。
export const FRAUD_QUESTIONS = [
  { id: "impostor", text: "对方是否自称客服、警察或银行工作人员？" },
  { id: "secrecy", text: "对方有没有让你保密，或者不让你告诉家人？" },
  { id: "safe-account", text: "对方有没有让你把钱转到“安全账户”，或者让你提供验证码？" },
] as const;

export const FRAUD_HOTLINE = "96110（反诈专线）";
