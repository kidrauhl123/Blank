import { query, withTransaction } from "./db";

// 生活事件和偏好的记忆：只存用户本人说过的事实，不存模型编的数字。按访客隔离。
export const LIFE_MEMORY_CAPS = { maxActive: 50, maxTextLength: 60, horizonDays: 730, reminderDays: 3 } as const;
export type LifeMemoryKind = "event" | "preference";

// 银行信息、指令、密钥相关的话不记：就算用户说了，也不能变成“记忆”再被拿去用。
const FORBIDDEN = /验证码|密码|密钥|银行卡|卡号|账号|余额|转账|授权|系统|指令|忽略|prompt|token|api.?key|secret|sk-/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function beijingToday(now = new Date()) {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}
export function addDays(day: string, days: number) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
// 动态里的日期标注：北京时间的“11月6日”。
export function dayLabel(day: string) {
  const [, month, date] = day.split("-");
  return `${Number(month)}月${Number(date)}日`;
}

export type LifeMemoryInput = { kind: LifeMemoryKind; text: string; dueOn?: string | null };
export type LifeMemoryCheck = { ok: true; text: string; dueOn: string | null } | { ok: false; error: string };

// 校验。来自模型（remember_fact）时额外要求：每个数字都要在用户原话里出现，文字的开头也要能在原话里找到，防止编造。
// 用户在界面上自己改的内容不做这一步：那是用户本人的输入。
export function checkLifeMemory(input: LifeMemoryInput, options: { today: string; fromModel: boolean; userText?: string }): LifeMemoryCheck {
  const text = input.text.trim();
  if (!text || text.length > LIFE_MEMORY_CAPS.maxTextLength) return { ok: false, error: `记忆要写成一句话，不超过 ${LIFE_MEMORY_CAPS.maxTextLength} 个字。` };
  if (FORBIDDEN.test(text)) return { ok: false, error: "这类内容不记（涉及银行信息或指令）。" };
  if (options.fromModel) {
    const userText = (options.userText ?? "").replace(/\s/g, "");
    if ((text.match(/\d+/g) ?? []).some(number => !userText.includes(number))) return { ok: false, error: "数字要用户自己说过，不能替用户记一个数字。" };
    if (!userText.includes(text.replace(/\s/g, "").slice(0, 4))) return { ok: false, error: "要用户自己说过的话才能记。" };
  }
  if (input.kind === "preference") {
    if (input.dueOn) return { ok: false, error: "偏好没有日期。" };
    return { ok: true, text, dueOn: null };
  }
  const dueOn = input.dueOn ?? null;
  if (!dueOn || !DAY.test(dueOn)) return { ok: false, error: "生活事件要带上具体日期（YYYY-MM-DD，北京时间）。" };
  if (dueOn < options.today || dueOn > addDays(options.today, LIFE_MEMORY_CAPS.horizonDays)) return { ok: false, error: "日期要是今天或以后，并且在两年之内。" };
  return { ok: true, text, dueOn };
}

export type LifeMemoryView = { id: string; kind: LifeMemoryKind; text: string; dueOn: string | null; version: string; updatedAt: string };
type Row = { id: string; kind: LifeMemoryKind; text: string; due_on: string | null; version: string; updated_at: Date };
const viewOf = (row: Row): LifeMemoryView => ({ id: row.id, kind: row.kind, text: row.text, dueOn: row.due_on, version: row.version, updatedAt: row.updated_at.toISOString() });
const COLUMNS = "id,kind,text,to_char(due_on,'YYYY-MM-DD') AS due_on,version::text AS version,updated_at";

// 对话里记住一件事（remember_fact）。同一句话只记一次：已经记过就更新日期。
export async function rememberLifeMemory(customerId: string, ownerId: string, input: LifeMemoryInput, options: { fromModel: boolean; userText?: string; now?: Date }) {
  const checked = checkLifeMemory(input, { today: beijingToday(options.now), fromModel: options.fromModel, userText: options.userText });
  if (!checked.ok) return checked;
  const existing = await query<{ id: string }>("SELECT id FROM visitor_life_memories WHERE customer_id=$1 AND visitor_owner_id=$2 AND kind=$3 AND text=$4 AND deleted_at IS NULL",
    [customerId, ownerId, input.kind, checked.text]);
  if (existing.rows[0]) {
    await query("UPDATE visitor_life_memories SET due_on=$2, version=version+1, updated_at=now() WHERE id=$1", [existing.rows[0].id, checked.dueOn]);
    return { ok: true as const, id: existing.rows[0].id, updated: true };
  }
  const count = await query<{ count: number }>("SELECT count(*)::int AS count FROM visitor_life_memories WHERE customer_id=$1 AND visitor_owner_id=$2 AND deleted_at IS NULL", [customerId, ownerId]);
  if (count.rows[0].count >= LIFE_MEMORY_CAPS.maxActive) return { ok: false as const, error: "记住的事已经很多了，先删掉一些不用的。" };
  const row = await query<{ id: string }>("INSERT INTO visitor_life_memories(customer_id,visitor_owner_id,kind,text,due_on) VALUES($1,$2,$3,$4,$5) RETURNING id",
    [customerId, ownerId, input.kind, checked.text, checked.dueOn]);
  return { ok: true as const, id: row.rows[0].id, updated: false };
}

export async function listLifeMemories(customerId: string, ownerId: string): Promise<LifeMemoryView[]> {
  const rows = await query<Row>(`SELECT ${COLUMNS} FROM visitor_life_memories WHERE customer_id=$1 AND visitor_owner_id=$2 AND deleted_at IS NULL
    ORDER BY due_on NULLS LAST, created_at`, [customerId, ownerId]);
  return rows.rows.map(viewOf);
}

// 界面上的修改：必须带着看到的版本号，旧版本不能覆盖新的修改（MEMORY_STALE）。
export async function updateLifeMemory(customerId: string, ownerId: string, id: string, expectedVersion: string, patch: { text?: string; dueOn?: string | null }, now = new Date()) {
  return withTransaction(async client => {
    const row = (await client.query<Row & { kind: LifeMemoryKind }>(`SELECT kind,${COLUMNS} FROM visitor_life_memories
      WHERE id=$1 AND customer_id=$2 AND visitor_owner_id=$3 AND deleted_at IS NULL FOR UPDATE`, [id, customerId, ownerId])).rows[0];
    if (!row) throw new Error("MEMORY_NOT_FOUND");
    if (row.version !== expectedVersion) throw new Error("MEMORY_STALE");
    const checked = checkLifeMemory({ kind: row.kind, text: patch.text ?? row.text, dueOn: patch.dueOn !== undefined ? patch.dueOn : row.due_on },
      { today: beijingToday(now), fromModel: false });
    if (!checked.ok) return checked;
    const updated = await client.query<Row>(`UPDATE visitor_life_memories SET text=$2, due_on=$3, version=version+1, updated_at=now()
      WHERE id=$1 RETURNING ${COLUMNS}`, [id, checked.text, checked.dueOn]);
    return { ok: true as const, memory: viewOf(updated.rows[0]) };
  });
}

// 删除是软删除：不再用于回答、也不再提醒。同样要带着版本号。
export async function deleteLifeMemory(customerId: string, ownerId: string, id: string, expectedVersion: string) {
  return withTransaction(async client => {
    const row = (await client.query<{ version: string }>(`SELECT version::text AS version FROM visitor_life_memories
      WHERE id=$1 AND customer_id=$2 AND visitor_owner_id=$3 AND deleted_at IS NULL FOR UPDATE`, [id, customerId, ownerId])).rows[0];
    if (!row) throw new Error("MEMORY_NOT_FOUND");
    if (row.version !== expectedVersion) throw new Error("MEMORY_STALE");
    await client.query("UPDATE visitor_life_memories SET deleted_at=now(), version=version+1, updated_at=now() WHERE id=$1", [id]);
  });
}

// 到期前几天内的生活事件：给动态心跳当候选（之后仍要过 Jev，通过才发布）。只查数据库。
export async function collectMemoryReminders(customerId: string, now = new Date()) {
  const today = beijingToday(now);
  const rows = await query<{ id: string; visitor_owner_id: string; text: string; due_on: string }>(
    `SELECT id,visitor_owner_id,text,to_char(due_on,'YYYY-MM-DD') AS due_on FROM visitor_life_memories
     WHERE customer_id=$1 AND deleted_at IS NULL AND kind='event' AND due_on BETWEEN $2::date AND $3::date
     ORDER BY due_on, created_at`,
    [customerId, today, addDays(today, LIFE_MEMORY_CAPS.reminderDays)]);
  return rows.rows.map(row => ({ id: row.id, ownerId: row.visitor_owner_id, text: row.text, dueOn: row.due_on }));
}
