import type { PoolClient } from "pg";
import { db, query, withTransaction } from "./db";
import { writeAudit } from "./audit";
import { getBankStatement } from "./bank-statements";
import { nextOccurrence, previousStatementMonth, scheduleInput, type ScheduleInput } from "./schedule-time";
import { processDailyReview } from "./scheduled-ai-reviews";
import { getJevStatus } from "./jev";
import { getAIStatus } from "./ai";
import { publishDueFeeds, publishScheduleResult } from "./feed-store";
import { advanceShowcaseLife } from "./demo-life";

export type ScheduledTask = {
  id: string; customer_id: string; kind: ScheduleInput["kind"]; title: string; message: string;
  frequency: ScheduleInput["frequency"]; timezone: string; starts_at: Date; ends_at: Date | null;
  next_run_at: Date; retry_at: Date | null; attempts: number;
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "CANCELLED" | "COMPLETED" | "ERROR";
  channel_identity_id: string | null; last_error: string | null; visitor_owner_id: string | null;
};
const KIND_SOURCE: Record<ScheduleInput["kind"], string> = { REMINDER: "提醒", MONTHLY_REPORT: "月度账单", SUBSCRIPTION_CHECK: "订阅检查", DAILY_AI_REVIEW: "每日巡检" };

// ownerId：对话里创建时是当前访客，只有他看得到、管得了；draft：先存成草稿，用户确认后再 activateScheduledDraft。
export async function createScheduledTask(customerId: string, raw: unknown, options: { ownerId?: string | null; draft?: boolean } = {}) {
  const input = scheduleInput.parse(raw);
  const ownerId = options.ownerId ?? null;
  return withTransaction(async client => {
    // Bound the number of tasks and serialize duplicate create requests per customer.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`schedule-create:${customerId}`]);
    const existing = await client.query<ScheduledTask>("SELECT * FROM scheduled_tasks WHERE customer_id=$1 AND request_key=$2", [customerId, input.requestKey]);
    if (existing.rows[0]) return existing.rows[0];
    const start = new Date(input.startsAt);
    if (start <= new Date() || start.getUTCFullYear() > 2099) throw new Error("SCHEDULE_START_INVALID");
    const count = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM scheduled_tasks WHERE customer_id=$1 AND status IN ('ACTIVE','PAUSED','ERROR')", [customerId]);
    if (count.rows[0].count >= 50) throw new Error("SCHEDULE_LIMIT");
    // 访客自己没确认过的旧草稿一天后清掉。
    if (options.draft && ownerId) await client.query("DELETE FROM scheduled_tasks WHERE customer_id=$1 AND visitor_owner_id=$2 AND status='DRAFT' AND created_at < now() - interval '1 day'", [customerId, ownerId]);
    if (input.channelIdentityId) {
      const channel = await client.query("SELECT id FROM channel_identities WHERE id=$1 AND customer_id=$2 AND status='ACTIVE' FOR SHARE", [input.channelIdentityId, customerId]);
      if (!channel.rowCount) throw new Error("CHANNEL_IDENTITY_NOT_FOUND");
    }
    const result = await client.query<ScheduledTask>(`INSERT INTO scheduled_tasks
      (customer_id,request_key,kind,title,message,frequency,starts_at,ends_at,next_run_at,channel_identity_id,visitor_owner_id,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$7,$9,$10,$11) RETURNING *`,
    [customerId, input.requestKey, input.kind, input.title, input.message, input.frequency, start, input.endsAt, input.channelIdentityId, ownerId, options.draft ? "DRAFT" : "ACTIVE"]);
    if (!options.draft) await writeAudit({ customerId, actorType: "USER", eventType: "SCHEDULE_CREATED", summary: "客户确认创建定时任务", evidence: { scheduleId: result.rows[0].id, kind: input.kind, frequency: input.frequency } }, client);
    return result.rows[0];
  });
}

// 用户在对话里确认之后，草稿才开始生效。id 省略时取这位访客 30 分钟内最近的草稿（确认发生在新的对话里时）。
export async function activateScheduledDraft(customerId: string, ownerId: string, id?: string) {
  return withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`schedule-create:${customerId}`]);
    const found = id
      ? await client.query<ScheduledTask>("SELECT * FROM scheduled_tasks WHERE id=$1 AND customer_id=$2 AND visitor_owner_id=$3 AND status='DRAFT' FOR UPDATE", [id, customerId, ownerId])
      : await client.query<ScheduledTask>("SELECT * FROM scheduled_tasks WHERE customer_id=$1 AND visitor_owner_id=$2 AND status='DRAFT' AND created_at > now() - interval '30 minutes' ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [customerId, ownerId]);
    const draft = found.rows[0];
    if (!draft) throw new Error("SCHEDULE_NOT_FOUND");
    if (draft.starts_at <= new Date()) throw new Error("SCHEDULE_START_INVALID");
    const count = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM scheduled_tasks WHERE customer_id=$1 AND status IN ('ACTIVE','PAUSED','ERROR')", [customerId]);
    if (count.rows[0].count >= 50) throw new Error("SCHEDULE_LIMIT");
    const result = await client.query<ScheduledTask>("UPDATE scheduled_tasks SET status='ACTIVE',updated_at=now() WHERE id=$1 RETURNING *", [draft.id]);
    await writeAudit({ customerId, actorType: "USER", eventType: "SCHEDULE_CREATED", summary: "客户在对话里确认创建定时任务", evidence: { scheduleId: draft.id, kind: draft.kind, frequency: draft.frequency, via: "BLANK_CHAT" } }, client);
    return result.rows[0];
  });
}

export async function getOwnedSchedule(customerId: string, ownerId: string, id: string) {
  const row = await query<ScheduledTask>("SELECT * FROM scheduled_tasks WHERE id=$1 AND customer_id=$2 AND visitor_owner_id=$3 AND status IN ('DRAFT','ACTIVE','PAUSED','ERROR')", [id, customerId, ownerId]);
  return row.rows[0] ?? null;
}

// 预览里的样例：用当前账本现算一次，让用户知道这个任务会发来什么。
export async function sampleScheduleResult(customerId: string, task: Pick<ScheduledTask, "kind" | "title" | "message">) {
  if (task.kind === "DAILY_AI_REVIEW") return "每天先由 Jev 判断账户有没有需要关注的变化；有才请主模型从账本事实里挑出重点告诉你，没有就保持安静。只读，不会替你转账或下单。";
  const client = await db.connect();
  try {
    const now = new Date();
    return (await executeReadOnlyTask(client, { ...task, customer_id: customerId, next_run_at: now } as ScheduledTask, now)).summary;
  } finally { client.release(); }
}

export async function listScheduledTasks(customerId: string, ownerId: string | null = null) {
  const [tasks, runs, heartbeat] = await Promise.all([
    query<ScheduledTask>("SELECT * FROM scheduled_tasks WHERE customer_id=$1 AND status<>'DRAFT' AND (visitor_owner_id IS NULL OR visitor_owner_id=$2) ORDER BY (status IN ('ACTIVE','PAUSED','ERROR')) DESC,created_at DESC LIMIT 200", [customerId, ownerId]),
    query(`SELECT r.*,t.title,
      CASE WHEN j.run_id IS NOT NULL THEN jsonb_build_object('status',j.status,'gate',j.gate,'result',j.result,'mainRequestedAt',j.main_requested_at,'error',j.last_error,
        'capturedAt',j.snapshot->>'capturedAt','facts',j.snapshot->'facts') END AS ai,
      (SELECT jsonb_build_object('status',o.status,'attempts',o.attempts) FROM channel_outbox o
       WHERE o.dedupe_key='schedule:'||r.id::text) AS delivery
      FROM scheduled_task_runs r JOIN scheduled_tasks t ON t.id=r.schedule_id
      LEFT JOIN scheduled_ai_reviews j ON j.run_id=r.id
      WHERE t.customer_id=$1 AND t.status<>'DRAFT' AND (t.visitor_owner_id IS NULL OR t.visitor_owner_id=$2) ORDER BY r.completed_at DESC LIMIT 50`, [customerId, ownerId]),
    query<{ last_tick_at: Date }>("SELECT last_tick_at FROM scheduler_heartbeat WHERE id=1"),
  ]);
  const lastTick = heartbeat.rows[0]?.last_tick_at ?? null;
  return { tasks: tasks.rows, runs: runs.rows, scheduler: { lastTickAt: lastTick, running: !!lastTick && Date.now() - lastTick.getTime() < 90_000 },
    dailyReview: { jev: getJevStatus(), mainModel: getAIStatus() } };
}

export async function changeScheduledTask(customerId: string, id: string, action: "pause" | "resume" | "cancel", ownerId: string | null = null) {
  return withTransaction(async client => {
    const result = await client.query<ScheduledTask>("SELECT * FROM scheduled_tasks WHERE id=$1 AND customer_id=$2 AND status<>'DRAFT' AND (visitor_owner_id IS NULL OR visitor_owner_id=$3) FOR UPDATE", [id, customerId, ownerId]);
    const task = result.rows[0];
    if (!task) throw new Error("SCHEDULE_NOT_FOUND");
    if (action === "cancel" && task.status === "CANCELLED") return task;
    if (["CANCELLED", "COMPLETED"].includes(task.status)) throw new Error("SCHEDULE_NOT_ACTIVE");
    let next = task.next_run_at;
    let status: ScheduledTask["status"] = action === "pause" ? "PAUSED" : action === "cancel" ? "CANCELLED" : "ACTIVE";
    if (action === "resume" && task.status !== "ACTIVE") {
      // Paused intervals are skipped; overdue one-off reminders resume once now.
      next = nextOccurrence(task.starts_at, task.frequency, new Date()) ?? new Date();
      if (task.ends_at && next > task.ends_at) status = "COMPLETED";
    }
    const updated = await client.query<ScheduledTask>(`UPDATE scheduled_tasks SET status=$3,next_run_at=$4,retry_at=NULL,attempts=0,last_error=NULL,updated_at=now()
      WHERE id=$1 AND customer_id=$2 RETURNING *`, [id, customerId, status, next]);
    if (task.kind === "DAILY_AI_REVIEW") await client.query(`WITH cancelled AS (
      UPDATE scheduled_ai_reviews j SET status='CANCELLED',lease_token=NULL,locked_until=NULL,updated_at=now()
      FROM scheduled_task_runs r WHERE r.id=j.run_id AND r.schedule_id=$1 AND j.status IN ('PENDING','RUNNING') RETURNING j.run_id)
      UPDATE scheduled_task_runs SET status='CANCELLED',summary='任务设置已变更，本轮检查停止。',completed_at=now()
      WHERE id IN (SELECT run_id FROM cancelled)`, [id]);
    await writeAudit({ customerId, actorType: "USER", eventType: "SCHEDULE_CHANGED", summary: "客户更新定时任务状态", evidence: { scheduleId: id, action, status } }, client);
    return updated.rows[0];
  });
}

function money(value: number) { return (value / 100).toFixed(2); }
async function executeReadOnlyTask(client: PoolClient, task: ScheduledTask, now: Date) {
  if (task.kind === "REMINDER") return { summary: `${task.title}：${task.message}`, notify: true };
  if (task.kind === "MONTHLY_REPORT") {
    const month = previousStatementMonth(task.next_run_at);
    const statement = await getBankStatement(task.customer_id, month, client);
    return { summary: `${month} 月度账单：共 ${statement.transactionCount} 笔，账面流入 ¥${money(statement.incomeMinor)}，账面流出 ¥${money(statement.expenseMinor)}。统计包含转账等资金往来，不等同于消费支出。`, notify: true };
  }
  const result = await client.query<{ merchant_name: string; amount_minor: string; next_charge_at: Date }>(`SELECT merchant_name,amount_minor,next_charge_at FROM subscriptions
    WHERE customer_id=$1 AND status='ACTIVE' AND next_charge_at >= $2 AND next_charge_at < $2::timestamptz+interval '3 days'
    ORDER BY next_charge_at LIMIT 50`, [task.customer_id, now]);
  const summary = result.rows.length ? `未来 72 小时订阅扣费记录（最多 50 项）：${result.rows.map(item => `${item.merchant_name} ¥${money(Number(item.amount_minor))}，${item.next_charge_at.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`).join("；")}。按已保存的扣费日期提醒，实际扣费以银行流水为准。`
    : "已检查：已保存的有效订阅中，未来 72 小时没有到期记录。";
  return { summary, notify: result.rows.length > 0 };
}

// Each occurrence, receipt and outbox message commit together. A process crash
// rolls back the claim; concurrent workers skip locked tasks. No network/LLM or
// money-moving operation is callable from this executor.
export async function tickScheduledTasks() {
  let processed = 0;
  for (let index = 0; index < 10; index++) {
    const found = await withTransaction(async client => {
      await client.query("SET LOCAL statement_timeout = '5s'");
      const clock = await client.query<{ now: Date }>("SELECT now() AS now");
      const now = clock.rows[0].now;
      const due = await client.query<ScheduledTask>(`SELECT t.* FROM scheduled_tasks t JOIN customers c ON c.id=t.customer_id
        WHERE t.status='ACTIVE' AND c.status='ACTIVE' AND t.next_run_at<=$1 AND (t.retry_at IS NULL OR t.retry_at<=$1)
        ORDER BY t.next_run_at FOR UPDATE OF t SKIP LOCKED LIMIT 1`, [now]);
      const task = due.rows[0];
      if (!task) return false;
      if (task.ends_at && now > task.ends_at) {
        await client.query("UPDATE scheduled_tasks SET status='COMPLETED',updated_at=now() WHERE id=$1", [task.id]);
        return true;
      }
      await client.query("SAVEPOINT occurrence");
      try {
        const isAI = task.kind === "DAILY_AI_REVIEW";
        const output = isAI ? { summary: "每日巡检已排队，等待 Jev 判断。", notify: false } : await executeReadOnlyTask(client, task, now);
        let identity: { id: string; channel_type: string } | undefined;
        if (task.channel_identity_id) {
          const active = await client.query<{ id: string; channel_type: string }>("SELECT id,channel_type FROM channel_identities WHERE id=$1 AND customer_id=$2 AND status='ACTIVE' FOR SHARE", [task.channel_identity_id, task.customer_id]);
          identity = active.rows[0];
          if (!identity) output.summary += " 通知绑定已失效，结果仅保存在 APP。";
        }
        const run = await client.query<{ id: string }>(`INSERT INTO scheduled_task_runs(schedule_id,scheduled_for,status,summary,attempts)
          VALUES($1,$2,$5,$3,$4) ON CONFLICT(schedule_id,scheduled_for) DO UPDATE
          SET status=excluded.status,summary=excluded.summary,attempts=excluded.attempts,completed_at=now() RETURNING id`, [task.id, task.next_run_at, output.summary, task.attempts + 1, isAI ? "PENDING" : "SUCCEEDED"]);
        if (isAI) await client.query("INSERT INTO scheduled_ai_reviews(run_id) VALUES($1) ON CONFLICT DO NOTHING", [run.rows[0].id]);
        else await publishScheduleResult(client, { customerId: task.customer_id, ownerId: task.visitor_owner_id, runId: run.rows[0].id, title: task.title, summary: output.summary, source: KIND_SOURCE[task.kind] });
        if (identity && output.notify) {
          // Send a generic notice; financial details and custom reminder text stay in APP.
          await client.query(`INSERT INTO channel_outbox(channel_identity_id,customer_id,channel_type,dedupe_key,payload)
            VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(dedupe_key) DO NOTHING`,
          [identity.id, task.customer_id, identity.channel_type, `schedule:${run.rows[0].id}`, JSON.stringify({ message: "Blank：你设置的定时任务已有新结果，请打开银行 APP 的「定时任务」查看。" })]);
        }
        const next = nextOccurrence(task.starts_at, task.frequency, now);
        const finished = !next || !!task.ends_at && next > task.ends_at;
        await client.query(`UPDATE scheduled_tasks SET status=$2,next_run_at=$3,retry_at=NULL,attempts=0,last_error=NULL,updated_at=now() WHERE id=$1`, [task.id, finished ? "COMPLETED" : "ACTIVE", next ?? task.next_run_at]);
        await writeAudit({ customerId: task.customer_id, actorType: "SYSTEM", eventType: isAI ? "DAILY_REVIEW_QUEUED" : "SCHEDULE_EXECUTED", summary: isAI ? "每日巡检已排队" : "定时任务结果已保存", evidence: { scheduleId: task.id, runId: run.rows[0].id, notificationQueued: !!identity && output.notify } }, client);
      } catch {
        await client.query("ROLLBACK TO SAVEPOINT occurrence");
        const attempts = task.attempts + 1;
        await client.query(`INSERT INTO scheduled_task_runs(schedule_id,scheduled_for,status,summary,attempts) VALUES($1,$2,'FAILED',$3,$4)
          ON CONFLICT(schedule_id,scheduled_for) DO UPDATE SET status='FAILED',summary=excluded.summary,attempts=excluded.attempts,completed_at=now()`,
        [task.id, task.next_run_at, attempts >= 3 ? "连续三次执行失败，任务已停止。可核对后恢复。" : "执行失败，后台稍后重试。", attempts]);
        await client.query(`UPDATE scheduled_tasks SET attempts=$2,status=$3,retry_at=$4,last_error='EXECUTION_FAILED',updated_at=now() WHERE id=$1`,
        [task.id, attempts, attempts >= 3 ? "ERROR" : "ACTIVE", new Date(now.getTime() + attempts * 60_000)]);
        await writeAudit({ customerId: task.customer_id, actorType: "SYSTEM", eventType: "SCHEDULE_FAILED", summary: "定时任务执行失败", evidence: { scheduleId: task.id, attempts } }, client);
      }
      return true;
    });
    if (!found) break;
    processed++;
  }
  await query("INSERT INTO scheduler_heartbeat(id,last_tick_at) VALUES(1,now()) ON CONFLICT(id) DO UPDATE SET last_tick_at=excluded.last_tick_at");
  const reviews = await processDailyReview();
  // 展示账户的生活模拟和动态发帖失败都不影响定时任务和巡检的心跳。
  await advanceShowcaseLife().catch(() => null);
  const posts = await publishDueFeeds().catch(() => 0);
  await query("UPDATE scheduler_heartbeat SET last_tick_at=now() WHERE id=1");
  return { processed, reviews, posts };
}
