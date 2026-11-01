import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { writeAudit } from "./audit";
import { query, withTransaction } from "./db";
import {
  BLANK_LINK_CAPS, KIND_SCOPE, RELATION_SCOPES, describeMessage, inviteCodeHash, inviteInput, acceptInput, messageInput, newInviteCode,
  type LinkRelation, type LinkScope, type MessageInput, type MessageKind,
} from "./blank-link";

// Blank 互联的数据部分：邀请、接受、撤销、发送、收件箱。所有写入先拿发送方的锁，并且只使用发送方自己的数据来填内容。
export type BlankLinkFailure = { ok: false; code: "INVALID" | "NOT_FOUND" | "DUPLICATE" | "LIMIT" | "FORBIDDEN"; error: string };
const fail = (code: BlankLinkFailure["code"], error: string): BlankLinkFailure => ({ ok: false, code, error });
const lock = (client: PoolClient, customerId: string) => client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`blank-link:${customerId}`]);
const isUnique = (error: unknown) => (error as { code?: string }).code === "23505";

// 邀请方创建邀请：只显示一次邀请码。范围不能超过这种关系允许的内容。
export async function createLinkInvite(customerId: string, raw: unknown, now = new Date()) {
  const parsed = inviteInput.safeParse(raw);
  if (!parsed.success) return fail("INVALID", "邀请的关系或内容范围不对。");
  const { relation, scopes } = parsed.data;
  if (scopes.some(scope => !RELATION_SCOPES[relation].includes(scope))) return fail("INVALID", "这种关系不能分享这类内容。");
  return withTransaction(async client => {
    await lock(client, customerId);
    const open = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM blank_link_invites WHERE from_customer_id=$1 AND used_at IS NULL AND expires_at > $2", [customerId, now]);
    if (open.rows[0].n >= BLANK_LINK_CAPS.maxOpenInvites) return fail("LIMIT", `同时最多有 ${BLANK_LINK_CAPS.maxOpenInvites} 个还没用的邀请。`);
    const code = newInviteCode();
    const expiresAt = new Date(now.getTime() + BLANK_LINK_CAPS.inviteMinutes * 60_000);
    await client.query("INSERT INTO blank_link_invites(code_hash,from_customer_id,relation,scopes,expires_at) VALUES($1,$2,$3,$4,$5)",
      [inviteCodeHash(code), customerId, relation, scopes, expiresAt]);
    await writeAudit({ customerId, actorType: "USER", eventType: "BLANK_LINK_INVITED", summary: "客户创建了互联邀请", evidence: { relation, scopes } }, client);
    return { ok: true as const, code, expiresAt: expiresAt.toISOString() };
  });
}

// 接受方在邀请范围内再选一部分内容，双方都同意后才生效。邀请码错误、过期、用过、或者输错太多次，都不会暴露是哪一种。
export async function acceptLinkInvite(customerId: string, raw: unknown, now = new Date()) {
  const parsed = acceptInput.safeParse(raw);
  if (!parsed.success) return fail("INVALID", "邀请码或授权范围不对。");
  const { code, scopes } = parsed.data;
  try {
    return await withTransaction(async client => {
      await lock(client, customerId);
      const failed = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_events WHERE customer_id=$1 AND event_type='BLANK_LINK_ACCEPT_FAILED' AND created_at > $2",
        [customerId, new Date(now.getTime() - 3_600_000)]);
      if (failed.rows[0].n >= BLANK_LINK_CAPS.maxFailedAccepts) return fail("LIMIT", "尝试次数太多，请一小时后再试。");
      const invite = (await client.query<{ id: string; from_customer_id: string; relation: LinkRelation; scopes: LinkScope[]; expires_at: Date; used_at: Date | null }>(
        "SELECT id,from_customer_id,relation,scopes,expires_at,used_at FROM blank_link_invites WHERE code_hash=$1 FOR UPDATE", [inviteCodeHash(code)])).rows[0];
      const usable = Boolean(invite && !invite.used_at && invite.expires_at > now && invite.from_customer_id !== customerId);
      if (!usable) {
        await writeAudit({ customerId, actorType: "USER", eventType: "BLANK_LINK_ACCEPT_FAILED", summary: "互联邀请码没有通过", evidence: {} }, client);
        return fail("NOT_FOUND", "邀请码无效、已用过或已过期。");
      }
      if (scopes.some(scope => !invite.scopes.includes(scope))) return fail("INVALID", "只能选择邀请里提供的内容。");
      const linked = await client.query<{ id: string }>("INSERT INTO blank_links(customer_a,customer_b,relation,scopes,status) VALUES($1,$2,$3,$4,'ACTIVE') RETURNING id",
        [invite.from_customer_id, customerId, invite.relation, scopes]);
      await client.query("UPDATE blank_link_invites SET used_at=$2, used_by_customer_id=$3 WHERE id=$1", [invite.id, now, customerId]);
      const evidence = { linkId: linked.rows[0].id, relation: invite.relation, scopes };
      await writeAudit({ customerId, actorType: "USER", eventType: "BLANK_LINK_CREATED", summary: "客户接受了互联邀请", evidence }, client);
      await writeAudit({ customerId: invite.from_customer_id, actorType: "USER", eventType: "BLANK_LINK_CREATED", summary: "对方接受了互联邀请", evidence }, client);
      return { ok: true as const, linkId: linked.rows[0].id, relation: invite.relation, scopes };
    });
  } catch (error) {
    if (isUnique(error)) return fail("DUPLICATE", "你们已经互联了。");
    throw error;
  }
}

// 我的互联（只列生效中的）和我发出、还没用的邀请（不含邀请码）。
export async function listBlankLinks(customerId: string) {
  const links = await query<{ id: string; relation: LinkRelation; scopes: LinkScope[]; created_at: Date; other_name: string }>(
    `SELECT l.id, l.relation, l.scopes, l.created_at, c.display_name AS other_name
     FROM blank_links l JOIN customers c ON c.id = CASE WHEN l.customer_a=$1 THEN l.customer_b ELSE l.customer_a END
     WHERE (l.customer_a=$1 OR l.customer_b=$1) AND l.status='ACTIVE' ORDER BY l.created_at`, [customerId]);
  const invites = await query<{ id: string; relation: LinkRelation; scopes: LinkScope[]; expires_at: Date }>(
    "SELECT id,relation,scopes,expires_at FROM blank_link_invites WHERE from_customer_id=$1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 5",
    [customerId]);
  return {
    links: links.rows.map(row => ({ linkId: row.id, relation: row.relation, scopes: row.scopes, otherName: row.other_name, createdAt: row.created_at.toISOString() })),
    invites: invites.rows.map(row => ({ inviteId: row.id, relation: row.relation, scopes: row.scopes, expiresAt: row.expires_at.toISOString() })),
  };
}

// 任何一方都可以随时撤销。撤销后互相都看不到对方的新消息，也不能再发。
export async function revokeBlankLink(customerId: string, linkId: string) {
  return withTransaction(async client => {
    const result = await client.query<{ customer_a: string; customer_b: string }>(
      "UPDATE blank_links SET status='REVOKED', revoked_at=now() WHERE id=$1 AND status='ACTIVE' AND (customer_a=$2 OR customer_b=$2) RETURNING customer_a,customer_b",
      [linkId, customerId]);
    if (!result.rows[0]) return fail("NOT_FOUND", "没有找到这条互联。");
    for (const party of [result.rows[0].customer_a, result.rows[0].customer_b]) {
      await writeAudit({ customerId: party, actorType: "USER", eventType: "BLANK_LINK_REVOKED", summary: "互联已撤销", evidence: { linkId } }, client);
    }
    return { ok: true as const, linkId };
  });
}

// 发送：只能发到双方都开放的内容种类；内容由服务端按发送方自己的数据填好，没有自由文本。
export async function sendBlankMessage(senderId: string, raw: unknown, now = new Date()) {
  const parsed = messageInput.safeParse(raw);
  if (!parsed.success) return fail("INVALID", "消息的内容格式不对。");
  const input = parsed.data;
  return withTransaction(async client => {
    await lock(client, senderId);
    const link = (await client.query<{ customer_a: string; customer_b: string; scopes: LinkScope[] }>(
      "SELECT customer_a,customer_b,scopes FROM blank_links WHERE id=$1 AND status='ACTIVE' AND (customer_a=$2 OR customer_b=$2) FOR SHARE",
      [input.linkId, senderId])).rows[0];
    if (!link) return fail("NOT_FOUND", "没有找到这条互联，或已经撤销。");
    if (!link.scopes.includes(KIND_SCOPE[input.kind])) return fail("FORBIDDEN", "这条互联没有开放这类内容。");
    const toId = link.customer_a === senderId ? link.customer_b : link.customer_a;
    const sent = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM blank_messages WHERE from_customer_id=$1 AND created_at > $2",
      [senderId, new Date(now.getTime() - 86_400_000)])).rows[0].n;
    if (sent >= BLANK_LINK_CAPS.maxDailyMessages) return fail("LIMIT", "今天发得太多了，明天再试。");
    const built = await buildPayload(client, senderId, input);
    if (!built.ok) return built;
    await client.query("INSERT INTO blank_messages(link_id,from_customer_id,to_customer_id,kind,payload,dedupe_key) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
      [input.linkId, senderId, toId, input.kind, JSON.stringify(built.payload), `${input.kind.toLowerCase()}:${randomUUID()}`]);
    await writeAudit({ customerId: senderId, actorType: "USER", eventType: "BLANK_LINK_MESSAGE_SENT", summary: "客户通过互联发送了一条消息", evidence: { linkId: input.linkId, kind: input.kind } }, client);
    return { ok: true as const, kind: input.kind };
  });
}

// 发送内容的构造。分账的每一笔都必须和发送方流水里的一笔完全一致（商户、金额、日期），不能凭空编造花费。
async function buildPayload(client: PoolClient, senderId: string, input: MessageInput) {
  const sender = (await client.query<{ display_name: string; phone: string }>("SELECT display_name,phone FROM customers WHERE id=$1", [senderId])).rows[0];
  if (input.kind === "REWARD") {
    return { ok: true as const, payload: { amountMinor: input.amountMinor, reason: input.reason, senderName: sender.display_name } };
  }
  if (input.kind === "SAVINGS_REQUEST") {
    const balance = (await client.query<{ total: string }>("SELECT coalesce(sum(available_balance_minor),0)::text AS total FROM accounts WHERE customer_id=$1", [senderId])).rows[0].total;
    return { ok: true as const, payload: { goal: input.goal, priceMinor: input.priceMinor, balanceMinor: Number(balance), senderName: sender.display_name } };
  }
  const items: Array<{ date: string; merchant: string; amountMinor: number; shareMinor: number }> = [];
  const seen = new Set<string>();
  for (const [index, item] of input.items.entries()) {
    if (item.shareMinor > item.amountMinor) return fail("INVALID", `第 ${index + 1} 笔的份额不能比这笔花费还多。`);
    // 同一笔花费只能分一次，否则份额会被重复计算。
    const key = `${item.date}|${item.merchant}|${item.amountMinor}`;
    if (seen.has(key)) return fail("INVALID", `第 ${index + 1} 笔和前面的重复了，同一笔花费只能分一次。`);
    seen.add(key);
    const found = await client.query(
      `SELECT 1 FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
       WHERE a.customer_id=$1 AND bt.merchant_name=$2 AND bt.amount_minor=$3 AND bt.category NOT IN ('转账','理财')
         AND (bt.occurred_at AT TIME ZONE 'Asia/Shanghai')::date = $4::date LIMIT 1`,
      [senderId, item.merchant, -item.amountMinor, item.date]);
    if (!found.rowCount) return fail("INVALID", `第 ${index + 1} 笔（${item.merchant}）在你的流水里找不到，不能分给对方。`);
    items.push({ date: item.date, merchant: item.merchant, amountMinor: item.amountMinor, shareMinor: item.shareMinor });
  }
  const totalShareMinor = items.reduce((sum, item) => sum + item.shareMinor, 0);
  return { ok: true as const, payload: { items, totalShareMinor, senderName: sender.display_name, payeeName: sender.display_name, payeePhone: sender.phone } };
}

// 收件箱：只给生效中、且仍在授权范围内的消息。分账要核对收件人自己的流水（同一家店前后一天内有没有记录）。
export async function listBlankInbox(customerId: string) {
  const rows = await query<{ id: string; link_id: string; kind: MessageKind; payload: Record<string, unknown>; created_at: Date; from_name: string; scopes: LinkScope[] }>(
    `SELECT m.id, m.link_id, m.kind, m.payload, m.created_at, c.display_name AS from_name, l.scopes
     FROM blank_messages m JOIN blank_links l ON l.id=m.link_id AND l.status='ACTIVE'
       JOIN customers c ON c.id=m.from_customer_id
     WHERE m.to_customer_id=$1 AND (l.customer_a=$1 OR l.customer_b=$1)
     ORDER BY m.created_at DESC LIMIT 30`, [customerId]);
  const messages = [];
  for (const row of rows.rows) {
    if (!row.scopes.includes(KIND_SCOPE[row.kind])) continue;
    const view = describeMessage(row.kind, row.payload, row.from_name);
    messages.push({
      messageId: row.id, linkId: row.link_id, kind: row.kind, fromName: row.from_name, createdAt: row.created_at.toISOString(),
      title: view.title, lines: view.lines,
      // 反诈提醒里发送方授权给家人的回电号码，给“打电话”用。
      callbackPhone: row.kind === "FRAUD_ALERT" && typeof row.payload.callbackPhone === "string" && row.payload.callbackPhone ? row.payload.callbackPhone : null,
      verification: row.kind === "SPLIT_REQUEST" ? await verifySplitItems(customerId, row.payload) : null,
    });
  }
  return messages;
}

async function verifySplitItems(customerId: string, payload: Record<string, unknown>) {
  const items = Array.isArray(payload.items) ? payload.items as Array<Record<string, unknown>> : [];
  const result = [];
  for (const item of items) {
    const merchant = String(item.merchant ?? "");
    const date = String(item.date ?? "");
    const seen = await query(
      `SELECT 1 FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
       WHERE a.customer_id=$1 AND bt.merchant_name=$2 AND (bt.occurred_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN ($3::date - 1) AND ($3::date + 1) LIMIT 1`,
      [customerId, merchant, date]);
    result.push({ date, merchant, shareMinor: Number(item.shareMinor ?? 0), matchedInYourLedger: (seen.rowCount ?? 0) > 0 });
  }
  return result;
}

// 反诈守护暂缓一笔转账时，告诉有“反诈提醒”授权的互联对象（只发固定内容：金额、原因、发送方的回电号码）。
// 和暂缓记录在同一个事务里写入，每条互联每笔操作只一条。
export async function notifyFraudHoldToLinks(client: PoolClient, input: { customerId: string; operationId: string; amountMinor: number; reasons: string[] }) {
  const links = await client.query<{ id: string; customer_a: string; customer_b: string }>(
    "SELECT id,customer_a,customer_b FROM blank_links WHERE status='ACTIVE' AND (customer_a=$1 OR customer_b=$1) AND 'FRAUD_ALERT' = ANY(scopes)", [input.customerId]);
  if (!links.rows.length) return 0;
  const sender = (await client.query<{ display_name: string; phone: string }>("SELECT display_name,phone FROM customers WHERE id=$1", [input.customerId])).rows[0];
  for (const link of links.rows) {
    const toId = link.customer_a === input.customerId ? link.customer_b : link.customer_a;
    await client.query(
      `INSERT INTO blank_messages(link_id,from_customer_id,to_customer_id,kind,payload,dedupe_key) VALUES($1,$2,$3,'FRAUD_ALERT',$4::jsonb,$5)
       ON CONFLICT (from_customer_id,dedupe_key) DO NOTHING`,
      [link.id, input.customerId, toId, JSON.stringify({
        amountMinor: input.amountMinor, reasons: input.reasons.slice(0, 5).map(reason => reason.slice(0, 60)),
        callbackPhone: sender.phone, senderName: sender.display_name,
      }), `fraud:${input.operationId}:${link.id}`]);
  }
  return links.rows.length;
}
