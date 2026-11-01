import { randomInt } from "node:crypto";
import { z } from "zod";
import { writeAudit } from "./audit";
import { BANK_BRANCHES, type BankBranch } from "./bank-branches";
import { query, withTransaction } from "./db";
import { estimateCnyYuan, FX_CURRENCIES } from "./fx-rates";
import { addDays, beijingToday } from "./life-memory";

// 网点预约：取号办理和换汇预约。只是预约，不扣款、不改变余额、不进账本。
// 流程：preview（草稿，30 分钟内有效）→ 用户在对话里确认 → save（生成取号单号）。每位访客最多 10 笔未取消的预约。
export const RESERVATION_CAPS = { maxBooked: 10, maxDaysAhead: 7, draftMinutes: 30, slotMinutes: 30, leadMinutes: 30 } as const;
const QUEUE_SERVICES = {
  personal: { label: "个人业务", needs: "queue" }, fx: { label: "换汇", needs: "fx" }, card: { label: "开卡", needs: "account" }, wealth: { label: "理财咨询", needs: "wealth" },
} as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT = /^([01]\d|2[0-3]):(00|30)$/;
const branchId = z.string().trim().min(1).max(40).describe("网点编号，来自 find_branches 的 id");
const date = z.string().regex(DATE).describe("预约日期 YYYY-MM-DD（北京时间），今天起 7 天以内");
const time = z.string().regex(SLOT).describe("时段 HH:mm，整点或半点，按网点营业时间选");

export const reservationInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("QUEUE"), branchId, service: z.enum(["personal", "fx", "card", "wealth"]).describe("personal 个人业务，fx 换汇，card 开卡，wealth 理财咨询"), date, time }).strict(),
  z.object({ kind: z.literal("FX"), branchId, direction: z.enum(["BUY", "SELL"]).describe("BUY 买入外币，SELL 卖出外币换人民币"),
    currency: z.enum(FX_CURRENCIES), amount: z.number().int().min(1).max(50000).describe("外币金额，整数，单位是该币种的整数单位（例如 1000 美元）"), date, time }).strict(),
]);
export type ReservationInput = z.infer<typeof reservationInput>;

const toMinutes = (clock: string) => { const [hour, minute] = clock.split(":").map(Number); return hour * 60 + minute; };

export function describeReservation(input: ReservationInput, branchName: string) {
  const when = `${input.date} ${input.time}`;
  if (input.kind === "QUEUE") return `${branchName} · 取号办理${QUEUE_SERVICES[input.service].label} · ${when}`;
  const estimate = estimateCnyYuan(input.currency, input.amount).toFixed(2);
  return `${branchName} · ${input.direction === "BUY" ? "买入" : "卖出"} ${input.amount} ${input.currency} · 参考折算约 ${estimate} 元（参考中间价，不是成交价）· ${when}`;
}

export type ReservationCheck = { ok: true; branch: BankBranch; summary: string } | { ok: false; error: string };

// 纯校验：网点存在且办理这项业务、日期在范围内、时段在营业时间内、且不是已经过去或太近的时段。now 由调用方传入，便于测试。
export function checkReservation(input: ReservationInput, now: Date): ReservationCheck {
  const branch = BANK_BRANCHES.find(item => item.id === input.branchId);
  if (!branch || branch.kind !== "BRANCH") return { ok: false, error: "没有这家网点。请先用 find_branches 查找网点编号。" };
  const needs = input.kind === "FX" ? "fx" : QUEUE_SERVICES[input.service].needs;
  if (!branch.services.includes(needs)) return { ok: false, error: `${branch.name}不办理这项业务，请换一家网点。` };
  const today = beijingToday(now);
  if (input.date < today) return { ok: false, error: "这个日期已经过去，请选择今天或之后的日期。" };
  if (input.date > addDays(today, RESERVATION_CAPS.maxDaysAhead)) return { ok: false, error: `预约日期要在今天起 ${RESERVATION_CAPS.maxDaysAhead} 天以内。` };
  const slotAt = Date.parse(`${input.date}T${input.time}:00+08:00`);
  if (Number.isNaN(slotAt)) return { ok: false, error: "日期不正确，请重新选择。" };
  const weekday = new Date(`${input.date}T00:00:00Z`).getUTCDay();
  const start = toMinutes(input.time);
  const openWindow = branch.windows.find(item => item.days.includes(weekday) && start >= toMinutes(item.open) && start + RESERVATION_CAPS.slotMinutes <= toMinutes(item.close));
  if (!openWindow) return { ok: false, error: `${branch.name}在 ${input.date} 的这个时段不营业，请选营业时间内的时段。` };
  if (slotAt < now.getTime() + RESERVATION_CAPS.leadMinutes * 60_000) return { ok: false, error: "这个时段太近或已经过去，请选择更晚的时段。" };
  return { ok: true, branch, summary: describeReservation(input, branch.name) };
}

export async function previewReservation(customerId: string, ownerId: string, input: ReservationInput, now = new Date()) {
  const checked = checkReservation(input, now);
  if (!checked.ok) return { error: checked.error };
  const inserted = await query<{ id: string }>(
    "INSERT INTO bank_reservations(customer_id,visitor_owner_id,kind,status,branch_id,detail) VALUES($1,$2,$3,'DRAFT',$4,$5::jsonb) RETURNING id",
    [customerId, ownerId, input.kind, input.branchId, JSON.stringify(input)]);
  return { reservationId: inserted.rows[0].id, summary: checked.summary, expiresInMinutes: RESERVATION_CAPS.draftMinutes };
}

// 保存时在同一把访客锁里再校验一次：预览之后时段可能已经过去，营业时间也可能变了。
export async function saveReservation(customerId: string, ownerId: string, reservationId?: string, now = new Date()) {
  return withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`reservation-owner:${ownerId}`]);
    const draft = await client.query<{ id: string; detail: unknown }>(
      `SELECT id,detail FROM bank_reservations
       WHERE customer_id=$1 AND visitor_owner_id=$2 AND status='DRAFT' AND created_at > now() - make_interval(mins => $3::int)
         AND ($4::uuid IS NULL OR id=$4::uuid)
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [customerId, ownerId, RESERVATION_CAPS.draftMinutes, reservationId ?? null]);
    const row = draft.rows[0];
    if (!row) return { error: `没有可以保存的预约，请先预览。预览 ${RESERVATION_CAPS.draftMinutes} 分钟内有效。` };
    const booked = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM bank_reservations WHERE customer_id=$1 AND visitor_owner_id=$2 AND status='BOOKED'", [customerId, ownerId]);
    if (booked.rows[0].n >= RESERVATION_CAPS.maxBooked) return { error: `已有 ${RESERVATION_CAPS.maxBooked} 笔未取消的预约，请先取消一些再预约。` };
    const parsed = reservationInput.safeParse(row.detail);
    if (!parsed.success) return { error: "预约信息已失效，请重新预览。" };
    const checked = checkReservation(parsed.data, now);
    if (!checked.ok) return { error: checked.error };
    const ticket = `${parsed.data.kind === "QUEUE" ? "Q" : "F"}${randomInt(100, 1000)}`;
    await client.query("UPDATE bank_reservations SET status='BOOKED', ticket=$2, booked_at=now() WHERE id=$1", [row.id, ticket]);
    await writeAudit({ customerId, actorType: "USER", eventType: "RESERVATION_BOOKED", summary: "客户预约网点办理",
      evidence: { reservationId: row.id, kind: parsed.data.kind, branchId: parsed.data.branchId } }, client);
    return { reservationId: row.id, ticket, summary: checked.summary };
  });
}

export async function listReservations(customerId: string, ownerId: string, now = new Date()) {
  const rows = await query<{ id: string; ticket: string; branch_id: string; detail: unknown }>(
    "SELECT id,ticket,branch_id,detail FROM bank_reservations WHERE customer_id=$1 AND visitor_owner_id=$2 AND status='BOOKED' ORDER BY booked_at DESC LIMIT 20",
    [customerId, ownerId]);
  const today = beijingToday(now);
  return rows.rows.flatMap(row => {
    const parsed = reservationInput.safeParse(row.detail);
    if (!parsed.success || parsed.data.date < today) return [];
    const branch = BANK_BRANCHES.find(item => item.id === row.branch_id);
    return [{ reservationId: row.id, ticket: row.ticket, summary: describeReservation(parsed.data, branch?.name ?? row.branch_id) }];
  });
}

export async function cancelReservation(customerId: string, ownerId: string, reservationId: string) {
  return withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`reservation-owner:${ownerId}`]);
    const result = await client.query<{ id: string }>(
      "UPDATE bank_reservations SET status='CANCELLED', cancelled_at=now() WHERE id=$1 AND customer_id=$2 AND visitor_owner_id=$3 AND status='BOOKED' RETURNING id",
      [reservationId, customerId, ownerId]);
    if (!result.rows[0]) return { error: "没有找到可以取消的预约。" };
    await writeAudit({ customerId, actorType: "USER", eventType: "RESERVATION_CANCELLED", summary: "客户取消网点预约", evidence: { reservationId } }, client);
    return { cancelled: true, reservationId };
  });
}
