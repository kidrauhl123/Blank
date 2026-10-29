import { randomUUID } from "node:crypto";
import { query, withTransaction } from "./db";
import { getAIStatus, selectDailyReviewFacts } from "./ai";
import { withPreferenceScope } from "./preference-runtime";
import { loadDailyReviewSnapshot } from "./daily-review-data";
import { dailyReviewSnapshotSchema, renderDailyReview, type DailyReviewSnapshot } from "./daily-review-policy";
import { evaluateDailyReview, jevGateSchema, type JevGate } from "./jev";
import { writeAudit } from "./audit";

type Claim = { run_id: string; schedule_id: string; customer_id: string; message: string; attempts: number;
  task_version: string; lease_token: string; snapshot: DailyReviewSnapshot | null; gate: JevGate | null; main_requested_at: Date | null };

async function claimReview(): Promise<Claim | null> {
  return withTransaction(async client => {
    // Lock order is always schedule -> run -> review. Remote calls happen after commit.
    const task = (await client.query<{ id: string; customer_id: string; message: string; version: string; status: string; customer_status: string; expired: boolean }>(`SELECT t.id,t.customer_id,t.message,t.updated_at::text AS version,t.status,c.status AS customer_status,(t.ends_at<now()) AS expired
      FROM scheduled_tasks t JOIN customers c ON c.id=t.customer_id
      WHERE t.kind='DAILY_AI_REVIEW' AND NOT EXISTS (
          SELECT 1 FROM scheduled_task_runs r JOIN scheduled_ai_reviews j ON j.run_id=r.id
          WHERE r.schedule_id=t.id AND j.status='RUNNING' AND j.locked_until>=now()) AND EXISTS (
          SELECT 1 FROM scheduled_task_runs r JOIN scheduled_ai_reviews j ON j.run_id=r.id
          WHERE r.schedule_id=t.id AND (j.retry_at IS NULL OR j.retry_at<=now())
            AND (j.status='PENDING' OR (j.status='RUNNING' AND j.locked_until<now())))
      ORDER BY t.next_run_at,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 1`)).rows[0];
    if (!task) return null;
    const row = (await client.query<{ run_id: string; attempts: number; snapshot: DailyReviewSnapshot | null; gate: JevGate | null; main_requested_at: Date | null }>(`SELECT j.* FROM scheduled_ai_reviews j JOIN scheduled_task_runs r ON r.id=j.run_id
      WHERE r.schedule_id=$1 AND (j.retry_at IS NULL OR j.retry_at<=now())
        AND (j.status='PENDING' OR (j.status='RUNNING' AND j.locked_until<now()))
      ORDER BY r.scheduled_for FOR UPDATE OF r,j SKIP LOCKED LIMIT 1`, [task.id])).rows[0];
    if (!row) return null;
    const inactive = !["ACTIVE", "COMPLETED"].includes(task.status) || task.customer_status !== "ACTIVE" || task.expired;
    if (inactive || row.attempts >= 3) {
      await client.query("UPDATE scheduled_ai_reviews SET status=$2,lease_token=NULL,locked_until=NULL,last_error=$3,updated_at=now() WHERE run_id=$1", [row.run_id, inactive ? "CANCELLED" : "ERROR", inactive ? "TASK_INACTIVE" : "LEASE_RETRIES_EXHAUSTED"]);
      await client.query("UPDATE scheduled_task_runs SET status=$2,summary=$3,completed_at=now() WHERE id=$1", [row.run_id, inactive ? "CANCELLED" : "FAILED", inactive ? "任务已停止，本轮检查取消。" : "执行中断达到三次，请核对服务后恢复任务。"]);
      if (!inactive) await client.query("UPDATE scheduled_tasks SET status='ERROR',last_error='LEASE_RETRIES_EXHAUSTED',updated_at=now() WHERE id=$1", [task.id]);
      return null;
    }
    const lease = randomUUID();
    await client.query("UPDATE scheduled_task_runs SET status='RUNNING',summary='正在检查账户并评估是否需要 AI 分析。',attempts=$2 WHERE id=$1", [row.run_id, row.attempts + 1]);
    await client.query("UPDATE scheduled_ai_reviews SET status='RUNNING',attempts=attempts+1,lease_token=$2,locked_until=now()+interval '90 seconds',retry_at=NULL,updated_at=now() WHERE run_id=$1", [row.run_id, lease]);
    return { ...row, attempts: row.attempts + 1, schedule_id: task.id, customer_id: task.customer_id, message: task.message, task_version: task.version, lease_token: lease };
  });
}

async function saveStage(claim: Claim, column: "snapshot" | "gate", value: unknown) {
  // Column comes only from this module's literal union, never request input.
  const result = await query(`UPDATE scheduled_ai_reviews SET ${column}=$3::jsonb,updated_at=now()
    WHERE run_id=$1 AND lease_token=$2 AND status='RUNNING' AND locked_until>now()`, [claim.run_id, claim.lease_token, JSON.stringify(value)]);
  if (!result.rowCount) throw new Error("DAILY_REVIEW_LEASE_LOST");
}

async function finishReview(claim: Claim, result: { factIds: string[]; mainModel: string | null; summary: string; gate: JevGate; capturedAt: string }) {
  return withTransaction(async client => {
    const task = (await client.query<{ status: string; version: string; channel_identity_id: string | null; expired: boolean; customer_status: string }>(`SELECT t.status,t.updated_at::text AS version,t.channel_identity_id,t.ends_at<now() AS expired,c.status AS customer_status
      FROM scheduled_tasks t JOIN customers c ON c.id=t.customer_id WHERE t.id=$1 FOR UPDATE OF t`, [claim.schedule_id])).rows[0];
    const lease = await client.query("SELECT run_id FROM scheduled_ai_reviews WHERE run_id=$1 AND lease_token=$2 AND status='RUNNING' AND locked_until>now() FOR UPDATE", [claim.run_id, claim.lease_token]);
    if (!lease.rowCount) return;
    const changed = !task || !["ACTIVE", "COMPLETED"].includes(task.status) || task.customer_status !== "ACTIVE" || task.version !== claim.task_version || task.expired;
    if (changed) {
      await client.query("UPDATE scheduled_ai_reviews SET status='CANCELLED',result=$2::jsonb,lease_token=NULL,locked_until=NULL,updated_at=now() WHERE run_id=$1", [claim.run_id, JSON.stringify({ ...result, suppressed: true })]);
      await client.query("UPDATE scheduled_task_runs SET status='CANCELLED',summary='任务已暂停、取消或变更，本轮结果未发布。',completed_at=now() WHERE id=$1", [claim.run_id]);
      return;
    }
    await client.query("UPDATE scheduled_ai_reviews SET status='DONE',result=$2::jsonb,lease_token=NULL,locked_until=NULL,last_error=NULL,updated_at=now() WHERE run_id=$1", [claim.run_id, JSON.stringify(result)]);
    await client.query("UPDATE scheduled_task_runs SET status=$2,summary=$3,completed_at=now() WHERE id=$1", [claim.run_id, result.gate.decision === "QUIET" ? "SKIPPED" : "SUCCEEDED", result.summary]);
    if (result.factIds.length && task.channel_identity_id) {
      const identity = (await client.query<{ id: string; channel_type: string }>("SELECT id,channel_type FROM channel_identities WHERE id=$1 AND customer_id=$2 AND status='ACTIVE' FOR SHARE", [task.channel_identity_id, claim.customer_id])).rows[0];
      if (identity) await client.query(`INSERT INTO channel_outbox(channel_identity_id,customer_id,channel_type,dedupe_key,payload)
        VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(dedupe_key) DO NOTHING`, [identity.id, claim.customer_id, identity.channel_type, `schedule:${claim.run_id}`,
        JSON.stringify({ message: "Blank：每日账户巡检有新的关注事项，请打开银行 APP 的「定时任务」查看。" })]);
    }
    await writeAudit({ customerId: claim.customer_id, actorType: "SYSTEM", eventType: "DAILY_REVIEW_COMPLETED", summary: "每日巡检结果已保存",
      evidence: { scheduleId: claim.schedule_id, runId: claim.run_id, jevModel: result.gate.model, probability: result.gate.probability, decision: result.gate.decision, mainModel: result.mainModel, factIds: result.factIds } }, client);
  });
}

async function failReview(claim: Claim, error: unknown) {
  const raw = error instanceof Error ? error.message : "DAILY_REVIEW_FAILED";
  if (raw === "DAILY_REVIEW_LEASE_LOST") return;
  const code = /^(JEV_[A-Z_0-9]+|AI_[A-Z_0-9]+|DAILY_REVIEW_INVALID_FACTS)$/.test(raw) ? raw : "DAILY_REVIEW_FAILED";
  const permanent = ["JEV_NOT_CONFIGURED", "JEV_CONFIG_INVALID", "JEV_HTTP_401", "JEV_HTTP_403", "AI_NOT_CONFIGURED"].includes(code) || claim.attempts >= 3;
  await withTransaction(async client => {
    const task = (await client.query<{ status: string; version: string }>("SELECT status,updated_at::text AS version FROM scheduled_tasks WHERE id=$1 FOR UPDATE", [claim.schedule_id])).rows[0];
    const changed = !task || !["ACTIVE", "COMPLETED"].includes(task.status) || task.version !== claim.task_version;
    const updated = await client.query(`UPDATE scheduled_ai_reviews SET status=$3,retry_at=$4,last_error=$5,lease_token=NULL,locked_until=NULL,updated_at=now()
      WHERE run_id=$1 AND lease_token=$2 AND status='RUNNING'`, [claim.run_id, claim.lease_token, changed ? "CANCELLED" : permanent ? "ERROR" : "PENDING",
      changed || permanent ? null : new Date(Date.now() + claim.attempts * 60_000), code]);
    if (!updated.rowCount) return;
    await client.query("UPDATE scheduled_task_runs SET status=$2,summary=$3,completed_at=now() WHERE id=$1", [claim.run_id, changed ? "CANCELLED" : permanent ? "FAILED" : "PENDING",
      changed ? "任务已变更，本轮检查停止。" : `每日巡检未完成（${code}）。${permanent ? "请检查服务配置后恢复任务。" : "后台将稍后重试。"}`]);
    if (!changed && permanent) await client.query("UPDATE scheduled_tasks SET status='ERROR',last_error=$2,updated_at=now() WHERE id=$1", [claim.schedule_id, code]);
    await writeAudit({ customerId: claim.customer_id, actorType: "SYSTEM", eventType: "DAILY_REVIEW_FAILED", summary: "每日巡检未完成", evidence: { scheduleId: claim.schedule_id, runId: claim.run_id, code, attempts: claim.attempts } }, client);
  });
}

export async function processDailyReview() {
  const claim = await claimReview();
  if (!claim) return 0;
  try {
    const saved = claim.snapshot ? dailyReviewSnapshotSchema.parse(claim.snapshot) : null;
    const reusable = !!saved && Date.now() - Date.parse(saved.capturedAt) <= 30 * 60_000;
    const snapshot = reusable ? saved! : await loadDailyReviewSnapshot(claim.customer_id, claim.message);
    if (!reusable) {
      await saveStage(claim, "snapshot", snapshot);
      await saveStage(claim, "gate", null);
    }
    const gate = reusable && claim.gate ? jevGateSchema.parse(claim.gate) : await evaluateDailyReview(snapshot);
    if (!reusable || !claim.gate) await saveStage(claim, "gate", gate);
    if (gate.decision === "QUIET") {
      await finishReview(claim, { factIds: [], mainModel: null, gate, capturedAt: snapshot.capturedAt,
        summary: claim.main_requested_at ? "Jev 判断最新快照无需进一步分析，本次未再次请求主模型；此前尝试有请求记录。" : "Jev 判断本次没有需要进一步分析的新事项，未调用主模型。" });
    } else {
      // Shared demo tasks never inherit any browser visitor's private preference memory.
      if (!getAIStatus().configured) throw new Error("AI_NOT_CONFIGURED");
      const requested = await query("UPDATE scheduled_ai_reviews SET main_requested_at=coalesce(main_requested_at,now()) WHERE run_id=$1 AND lease_token=$2 AND status='RUNNING' AND locked_until>now()", [claim.run_id, claim.lease_token]);
      if (!requested.rowCount) throw new Error("DAILY_REVIEW_LEASE_LOST");
      const review = await withPreferenceScope(null, () => selectDailyReviewFacts(snapshot));
      const required = snapshot.facts.filter(fact => fact.required && !snapshot.recentlyHighlighted.includes(fact.id)).map(fact => fact.id);
      const factIds = [...new Set([...required, ...review.value.factIds])].slice(0, 3);
      // Validate all model IDs before limiting or rendering them.
      renderDailyReview(snapshot, review.value.factIds);
      const summary = renderDailyReview(snapshot, factIds) || "主模型已检查本次账户快照，没有新增关注事项。";
      await finishReview(claim, { factIds, mainModel: review.meta.model, gate, capturedAt: snapshot.capturedAt, summary });
    }
  } catch (error) { await failReview(claim, error); }
  return 1;
}
