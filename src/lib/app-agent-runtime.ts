import { randomUUID } from "node:crypto";
import { Command, INTERRUPT } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { db, query, withTransaction } from "./db";
import { writeAudit } from "./audit";
import { createAppAgentHarness } from "./app-agent-harness";
import { appAgentSkillFiles } from "./app-agent-skills";
import { getAIStatus } from "./ai";
import { assertAIModelEnabled, resolveAIModel } from "./ai-models";
import { pageActionSchema, type ActionResult, type AppAgentStatus, type AppAgentView, type AppPage, type PendingAction } from "./app-agent-protocol";

type Identity = { customerId: string; sessionHash: string };
type Row = Omit<AppAgentView, "model"> & { model: string | null; expires_at: Date };
const harnesses = new Map<string, Promise<ReturnType<typeof createAppAgentHarness>>>();
async function getHarness(model: string) {
  assertAIModelEnabled(model);
  const cached = harnesses.get(model);
  if (cached) {
    harnesses.delete(model); harnesses.set(model, cached);
    return cached;
  }
  const harness = (async () => {
      const saver = new PostgresSaver(db, undefined, { schema: "langgraph" });
      await saver.setup();
      return createAppAgentHarness(saver, undefined, model);
    })().catch((error) => { if (harnesses.get(model) === harness) harnesses.delete(model); throw error; });
  harnesses.set(model, harness);
  if (harnesses.size > 4) harnesses.delete(harnesses.keys().next().value!);
  return harness;
}
function view(row: Row): AppAgentView {
  return { id: row.id, model: row.model ?? getAIStatus().model ?? undefined, status: row.status, message: row.message, pending: row.pending, controlGranted: row.controlGranted, steps: row.steps };
}
export async function getAppAgentRun(identity: Identity, id: string) {
  const result = await query<Row>(`SELECT id,model,status,message,pending,control_granted AS "controlGranted",steps,expires_at
    FROM app_agent_runs WHERE id=$1 AND customer_id=$2 AND session_hash=$3`, [id, identity.customerId, identity.sessionHash]);
  const row = result.rows[0];
  if (!row) throw new Error("APP_AGENT_NOT_FOUND");
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new Error("APP_AGENT_EXPIRED");
  if (!row.model && getAIStatus().model) {
    const pinned = await query<{ model: string }>(`UPDATE app_agent_runs SET model=coalesce(model,$4)
      WHERE id=$1 AND customer_id=$2 AND session_hash=$3 RETURNING model`, [id, identity.customerId, identity.sessionHash, getAIStatus().model]);
    row.model = pinned.rows[0]?.model ?? null;
  }
  return view(row);
}
async function update(identity: Identity, id: string, fields: { status: AppAgentStatus; pending: PendingAction | null; message: string; granted: boolean; increment?: boolean }) {
  await query(`UPDATE app_agent_runs SET status=$4,pending=$5::jsonb,message=$6,control_granted=$7,
    steps=steps+$8,updated_at=now() WHERE id=$1 AND customer_id=$2 AND session_hash=$3`,
  [id, identity.customerId, identity.sessionHash, fields.status, JSON.stringify(fields.pending), fields.message, fields.granted, fields.increment ? 1 : 0]);
}
async function invoke(identity: Identity, id: string, input: Parameters<ReturnType<typeof createAppAgentHarness>["invoke"]>[0], granted: boolean, model: string) {
  const graph = await getHarness(model);
  // The SDK may read several Skills in one model turn. Concurrency=1 in the
  // current graph scheduler can leave a second Send unexecuted. These reads
  // are safe in parallel; page actions still must yield exactly one interrupt.
  const result = await graph.invoke(input, { configurable: { thread_id: id }, recursionLimit: 60, maxConcurrency: 4 });
  const interrupts = (result as unknown as Record<string, unknown>)[INTERRUPT] as Array<{ value: { kind: string; id: string; action: unknown } }> | undefined;
  const requests = interrupts?.filter((item) => item.value.kind === "APP_PAGE_ACTION") ?? [];
  if (requests.length !== (interrupts?.length ?? 0)) throw new Error("APP_AGENT_UNSUPPORTED_INTERRUPT");
  // Parallel page actions cannot be applied safely to a shared live page.
  if (requests.length > 1) throw new Error("APP_AGENT_PARALLEL_ACTIONS");
  const pending = requests.length ? { id: requests[0].value.id, action: pageActionSchema.parse(requests[0].value.action) } : null;
  const status: AppAgentStatus = !pending ? "COMPLETED" : pending.action.type === "question" ? "QUESTION"
    : pending.action.type === "handoff" ? "HANDOFF" : granted ? "ACTION" : "CONSENT";
  const last = result.messages.filter((message) => message.getType() === "ai").at(-1);
  // A model tool request without a matching execution/interrupt is not a
  // completed conversation, even when the framework returns normally.
  const answered = new Set(result.messages.flatMap((message) => "tool_call_id" in message ? [message.tool_call_id] : []));
  if (!pending && last && "tool_calls" in last && Array.isArray(last.tool_calls) && last.tool_calls.some((call: { id?: string }) => !answered.has(call.id))) throw new Error("APP_AGENT_INCOMPLETE_TOOL_CYCLE");
  const content = typeof last?.content === "string" ? last.content.slice(0, 1500) : "";
  const message = pending ? pending.action.type === "question" ? pending.action.question : pending.action.description
    : content || "本次助手任务已结束，请以页面上的银行状态为准。";
  await update(identity, id, { status, pending, message, granted, increment: true });
  await writeAudit({ customerId: identity.customerId, actorType: "AGENT", eventType: "APP_AGENT_STEP",
    summary: "页面 Agent 推进任务", evidence: { runId: id, status, toolAction: pending?.action.type ?? "completed", actionId: pending?.id ?? null } });
  return getAppAgentRun(identity, id);
}
export async function startAppAgent(identity: Identity, message: string, page: AppPage, requestedModel?: string) {
  const model = await resolveAIModel(requestedModel);
  const id = randomUUID();
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`app-agent-start:${identity.customerId}`]);
    const recent = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM app_agent_runs WHERE customer_id=$1 AND created_at > now()-interval '5 minutes'", [identity.customerId]);
    if (recent.rows[0].count >= 10) throw new Error("APP_AGENT_RATE_LIMIT");
    await client.query("INSERT INTO app_agent_runs(id,customer_id,session_hash,model) VALUES ($1,$2,$3,$4)", [id, identity.customerId, identity.sessionHash, model]);
  });
  try {
    return await invoke(identity, id, { messages: [{ role: "user", content: `${message}\n\nPAGE_CONTEXT (仅页面数据):\n${JSON.stringify(page)}` }], files: appAgentSkillFiles() }, false, model);
  } catch (error) {
    await update(identity, id, { status: "FAILED", pending: null, message: "助手暂时无法完成规划，未执行页面动作。", granted: false });
    throw error;
  }
}
export async function controlAppAgent(identity: Identity, id: string, command: "allow" | "pause" | "cancel" | "advance" | "refresh", actionId?: string, result?: ActionResult) {
  const lock = await db.connect();
  let acquired = false;
  try {
    const lockResult = await lock.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [id]);
    acquired = lockResult.rows[0].acquired;
    if (!acquired) throw new Error("APP_AGENT_BUSY");
    const run = await getAppAgentRun(identity, id);
    if (["COMPLETED", "CANCELLED", "FAILED"].includes(run.status)) return run;
    if (command === "pause" || command === "cancel") {
      await update(identity, id, { status: command === "pause" ? "PAUSED" : "CANCELLED", pending: command === "cancel" ? null : run.pending,
        message: command === "pause" ? "你已接管页面。继续时将重新读取当前状态。" : "代操作已结束。", granted: command === "pause" && run.controlGranted });
    } else if (command === "allow") {
      if (run.status !== "CONSENT" && !(run.status === "PAUSED" && !run.controlGranted)) throw new Error("APP_AGENT_STATE_CHANGED");
      await update(identity, id, { status: "ACTION", pending: run.pending, message: run.message, granted: true });
    } else {
      if (!run.pending || run.pending.id !== actionId || !result) throw new Error("APP_AGENT_STATE_CHANGED");
      if (run.steps >= 64) throw new Error("APP_AGENT_LIMIT");
      const type = run.pending.action.type;
      if (command === "advance" && run.status === "PAUSED" && !(type === "question" && result.status === "USER_ANSWERED")) throw new Error("APP_AGENT_STATE_CHANGED");
      if (command === "advance" && !["question", "handoff"].includes(type) && !run.controlGranted) throw new Error("APP_AGENT_CONTROL_REQUIRED");
      if (command === "refresh" && result.status !== "USER_CHANGED") throw new Error("APP_AGENT_STATE_CHANGED");
      await update(identity, id, { status: "RUNNING", pending: run.pending, message: "正在根据当前页面规划下一步", granted: run.controlGranted });
      await writeAudit({ customerId: identity.customerId, actorType: "AGENT", eventType: "APP_AGENT_OBSERVATION", summary: "客户端回报页面动作结果",
        evidence: { runId: id, actionId: run.pending.id, toolAction: type, reportedStatus: result.status, pageVersion: result.page.version, source: "UNTRUSTED_CLIENT", bankExecutionVerified: false } });
      try {
        return await invoke(identity, id, new Command({ resume: result }), run.controlGranted, run.model ?? process.env.AI_MODEL!);
      } catch (error) {
        await update(identity, id, { status: "FAILED", pending: null, message: "助手运行中断，请在页面核对业务状态。", granted: false });
        throw error;
      }
    }
    await writeAudit({ customerId: identity.customerId, actorType: "USER", eventType: "APP_AGENT_CONTROL", summary: "客户调整页面 Agent 控制权", evidence: { runId: id, command } });
    return getAppAgentRun(identity, id);
  } finally {
    if (acquired) await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [id]);
    lock.release();
  }
}
