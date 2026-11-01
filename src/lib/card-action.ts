import { query } from "./db";

// 卡片办理的服务端检查：核对卡片状态、尾号是否唯一、挂失是否支持。真正的操作仍在页面里完成，并交给用户本人确认。
// 锁卡不等于挂失；挂失和解挂暂未上线，这里直接说明，不能让模型把锁卡说成挂失。
export const CARD_ACTIONS = ["apply_virtual", "lock", "report_loss"] as const;
export type CardAction = (typeof CARD_ACTIONS)[number];
export type CardRow = { card_name: string; masked_no: string; status: string; card_type: string };
export type CardActionInput = { action: CardAction; last4?: string; cardName?: string };

const last4Of = (maskedNo: string) => maskedNo.replace(/\s/g, "").slice(-4);
const STATUS_TEXT: Record<string, string> = { ACTIVE: "正常", LOCKED: "已锁定" };
const describeCard = (card: CardRow) => ({ name: card.card_name, last4: last4Of(card.masked_no), status: STATUS_TEXT[card.status] ?? "暂不可办理" });

export function planCardAction(input: CardActionInput, cards: CardRow[]) {
  if (input.action === "report_loss") {
    return { status: "UNSUPPORTED", message: "挂失和解挂暂未在 App 上线。卡片遗失或被盗刷时，请先在卡片页锁卡（锁卡不等于挂失），再致电 95588 或到网点办理挂失。不要说已经挂失。" };
  }
  if (input.action === "apply_virtual") {
    if (!input.cardName) return { error: "请先问用户给这张虚拟卡起个名字（2 到 12 个字）。" };
    return { status: "READY", cardName: input.cardName, next: "打开卡片页，进入申请虚拟卡的表单，填写名称后交给用户本人确认（handoff_to_user）。完成以页面回执为准。" };
  }
  if (!cards.length) return { error: "当前账户没有卡片，无法锁卡。" };
  const matches = cards.filter(card => !input.last4 || last4Of(card.masked_no) === input.last4);
  if (!matches.length) return { error: "没有找到这个尾号的卡片，请用户确认尾号。" };
  const active = matches.filter(card => card.status === "ACTIVE");
  if (!active.length) {
    if (matches.every(card => card.status === "LOCKED")) return { status: "ALREADY_LOCKED", cards: matches.map(describeCard), message: "这张卡已经是锁定状态。" };
    return { error: "这张卡暂不可锁定，请到网点或致电 95588 咨询。", cards: matches.map(describeCard) };
  }
  if (active.length > 1) return { status: "CHOOSE", cards: active.map(describeCard), instruction: "卡片不止一张：用 ask_user 展示卡名和尾号让用户选择，不要替用户选。" };
  return { status: "READY", card: describeCard(active[0]), next: "打开卡片页，选中这张卡并进入锁卡操作，等待用户本人确认（handoff_to_user）。完成以页面回执为准。" };
}

export async function cardAction(customerId: string, input: CardActionInput) {
  const cards = await query<CardRow>("SELECT card_name,masked_no,status,card_type FROM cards WHERE customer_id=$1 ORDER BY card_name", [customerId]);
  return planCardAction(input, cards.rows);
}
