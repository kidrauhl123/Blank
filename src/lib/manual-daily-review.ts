import { z } from "zod";
import { withTransaction } from "./db";
import { writeAudit } from "./audit";
import { getJevStatus } from "./jev";
import { getAIStatus } from "./ai";

export const manualReviewInput = z.object({ scheduleId: z.string().uuid(), requestKey: z.string().uuid() }).strict();

export async function requestManualDailyReview(customerId: string, raw: unknown) {
  const input = manualReviewInput.parse(raw);
  return withTransaction(async client => {
    // Serialize customer-wide manual requests, then use the same task lock as the scheduler.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`manual-review:${customerId}`]);
    const task = (await client.query<{ id: string; kind: string; status: string; expired: boolean }>(`SELECT t.id,t.kind,t.status,t.ends_at<now() AS expired
      FROM scheduled_tasks t JOIN customers c ON c.id=t.customer_id WHERE t.id=$1 AND t.customer_id=$2 AND c.status='ACTIVE' FOR UPDATE OF t`, [input.scheduleId, customerId])).rows[0];
    if (!task) throw new Error("SCHEDULE_NOT_FOUND");
    const prior = (await client.query<{ id: string; schedule_id: string }>(`SELECT r.id,r.schedule_id FROM scheduled_task_runs r
      JOIN scheduled_tasks t ON t.id=r.schedule_id WHERE r.manual_request_key=$1 AND t.customer_id=$2`, [input.requestKey, customerId])).rows[0];
    if (prior) {
      if (prior.schedule_id !== task.id) throw new Error("REVIEW_REQUEST_MISMATCH");
      return { runId: prior.id };
    }
    if (task.kind !== "DAILY_AI_REVIEW" || task.status !== "ACTIVE" || task.expired) throw new Error("REVIEW_TASK_NOT_ACTIVE");
    if (!getJevStatus().configured || !getAIStatus().configured) throw new Error("REVIEW_NOT_CONFIGURED");
    if ((await client.query(`SELECT 1 FROM scheduled_task_runs r JOIN scheduled_ai_reviews j ON j.run_id=r.id
      WHERE r.schedule_id=$1 AND j.status IN ('PENDING','RUNNING') LIMIT 1`, [task.id])).rowCount) throw new Error("REVIEW_ALREADY_RUNNING");
    const recent = (await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM scheduled_task_runs r JOIN scheduled_tasks t ON t.id=r.schedule_id
      WHERE t.customer_id=$1 AND r.trigger_source='MANUAL' AND r.scheduled_for>=now()-interval '24 hours'`, [customerId])).rows[0].count;
    if (recent >= 12) throw new Error("REVIEW_DAILY_LIMIT");
    const runId = (await client.query<{ id: string }>(`INSERT INTO scheduled_task_runs(schedule_id,scheduled_for,status,summary,attempts,trigger_source,manual_request_key)
      VALUES($1,clock_timestamp(),'PENDING','手动检查已排队，等待后台执行。',0,'MANUAL',$2) RETURNING id`, [task.id, input.requestKey])).rows[0].id;
    await client.query("INSERT INTO scheduled_ai_reviews(run_id) VALUES($1)", [runId]);
    await writeAudit({ customerId, actorType: "USER", eventType: "DAILY_REVIEW_REQUESTED", summary: "客户手动请求额外检查一次",
      evidence: { scheduleId: task.id, runId, source: "MANUAL", recurringScheduleChanged: false } }, client);
    return { runId };
  });
}
