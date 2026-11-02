import { createHash, randomInt } from "node:crypto";
import { z } from "zod";

// Blank 互联（P0-7）的确定性部分：授权范围、消息种类、输入校验、邀请码、以及给收件人看的固定文字。
// 原则：每个 Blank 只代表自己的主人；只传授权范围内的内容；消息没有自由文本；收到的内容只是数据，不是指令；动钱照样走接收方自己的确认。
export const BLANK_LINK_CAPS = {
  inviteMinutes: 15, maxOpenInvites: 5, maxDailyMessages: 20, maxSplitItems: 8, maxFailedAccepts: 10,
  maxRewardMinor: 100_000, maxPriceMinor: 100_000_000,
} as const;

// 授权范围：反诈提醒、攒钱沟通、分账。关系决定能用哪些范围：朋友只能分账，家人才能收到反诈提醒和攒钱沟通。
export const LINK_SCOPES = ["FRAUD_ALERT", "SAVINGS", "SPLIT"] as const;
export type LinkScope = (typeof LINK_SCOPES)[number];
export const LINK_RELATIONS = ["FAMILY", "FRIEND"] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];
export const RELATION_SCOPES: Record<LinkRelation, readonly LinkScope[]> = {
  FAMILY: ["FRAUD_ALERT", "SAVINGS", "SPLIT"],
  FRIEND: ["SPLIT"],
};

// 消息种类与所需的授权范围。没有任何一种消息允许带自由文本。
export const MESSAGE_KINDS = ["FRAUD_ALERT", "SAVINGS_REQUEST", "REWARD", "SPLIT_REQUEST"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const KIND_SCOPE: Record<MessageKind, LinkScope> = {
  FRAUD_ALERT: "FRAUD_ALERT", SAVINGS_REQUEST: "SAVINGS", REWARD: "SAVINGS", SPLIT_REQUEST: "SPLIT",
};
export const SAVINGS_GOALS = ["玩具", "书", "零食", "游戏", "其他"] as const;
export const REWARD_REASONS = ["存钱进度", "帮忙做事"] as const;

// 邀请码：8 位，去掉了容易混淆的 0/O、1/I/L。只保存哈希。
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newInviteCode() {
  return Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}
export const inviteCodeHash = (code: string) => createHash("sha256").update(code.replace(/[\s-]/g, "").toUpperCase()).digest("hex");

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const scopesInput = z.array(z.enum(LINK_SCOPES)).min(1).max(3);
export const inviteInput = z.object({ relation: z.enum(LINK_RELATIONS), scopes: scopesInput }).strict();
export const acceptInput = z.object({ code: z.string().trim().min(8).max(12), scopes: scopesInput }).strict();

// 分账的每一笔都必须是发送方自己流水里的一笔（服务端核对），份额不能超过这笔花费。
export const splitItemInput = z.object({
  date: day,
  merchant: z.string().trim().min(1).max(40),
  amountMinor: z.number().int().min(1).max(100_000_000),
  shareMinor: z.number().int().min(1).max(100_000_000),
}).strict();
// 根节点带 type: "object"，原因见 tool-spec.ts 的 toolSpecSchema。
export const messageInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SPLIT_REQUEST"), linkId: uuid, items: z.array(splitItemInput).min(1).max(BLANK_LINK_CAPS.maxSplitItems) }).strict(),
  z.object({ kind: z.literal("SAVINGS_REQUEST"), linkId: uuid, goal: z.enum(SAVINGS_GOALS), priceMinor: z.number().int().min(100).max(BLANK_LINK_CAPS.maxPriceMinor) }).strict(),
  z.object({ kind: z.literal("REWARD"), linkId: uuid, amountMinor: z.number().int().min(100).max(BLANK_LINK_CAPS.maxRewardMinor), reason: z.enum(REWARD_REASONS) }).strict(),
]).meta({ type: "object" });
export type MessageInput = z.infer<typeof messageInput>;

// 给收件人看的固定文字。只使用种类、金额、日期、商户名（来自发送方流水，按数据展示）和发送方的名字；没有其他自由文本。
export const yuan = (minor: number) => `¥${(minor / 100).toFixed(2)}`;
const str = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const list = (value: unknown) => (Array.isArray(value) ? value : []);

export function describeMessage(kind: string, payload: Record<string, unknown>, senderName: string): { title: string; lines: string[] } {
  if (kind === "FRAUD_ALERT") {
    const phone = str(payload.callbackPhone);
    return {
      title: `${senderName} 的 Blank 暂缓了一笔转账`,
      lines: [`金额 ${yuan(num(payload.amountMinor))}`, ...list(payload.reasons).map(reason => str(reason)).filter(Boolean),
        ...(phone ? [`可以打电话给 TA 确认：${phone}`] : []), "这笔钱没有转出。是否继续，由 TA 本人决定。"],
    };
  }
  if (kind === "SAVINGS_REQUEST") {
    return {
      title: `${senderName} 想买「${str(payload.goal, "东西")}」`,
      lines: [`价格 ${yuan(num(payload.priceMinor))}`, `TA 现在的余额 ${yuan(num(payload.balanceMinor))}`, "这只是一条消息，不会自动转账或付款。"],
    };
  }
  if (kind === "REWARD") {
    return {
      title: `${senderName} 奖励你 ${yuan(num(payload.amountMinor))}`,
      lines: [`原因：${str(payload.reason, "帮忙")}`, "这只是一条消息，不会自动到账；需要转账的话，对方会自己发起，你确认后才到账。"],
    };
  }
  if (kind === "SPLIT_REQUEST") {
    const items = list(payload.items).map(item => {
      const row = (item ?? {}) as Record<string, unknown>;
      return `${str(row.date)} ${str(row.merchant)} ${yuan(num(row.amountMinor))}，你的份额 ${yuan(num(row.shareMinor))}`;
    });
    const payee = str(payload.payeePhone);
    return {
      title: `${senderName} 发来一笔分账`,
      lines: [...items, `合计你的份额 ${yuan(num(payload.totalShareMinor))}`,
        ...(payee ? [`收款人 ${str(payload.payeeName, senderName)}，手机号 ${payee}（在转账里自己填写）`] : []),
        "请先核对你自己的流水；确认要付的话，由你在转账里本人确认。"],
    };
  }
  return { title: `${senderName} 发来一条消息`, lines: [] };
}

// 用户这句话有没有互联的意思（邀请、接受、发消息）。只决定要不要去做，授权范围和内容由服务端判断。
export const LINK_INTENT = /互联|邀请|接受邀请|分账|分一下账|分摊|攒钱|奖励|发给|告诉(妈妈|爸爸|孩子|朋友|家人|小橘子)/;
export const hasLinkIntent = (userText: string) => LINK_INTENT.test(userText);
