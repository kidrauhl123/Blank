import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, query } from "./db";
import { controlAppAgent, getAppAgentRun, startAppAgent } from "./app-agent-runtime";
import type { AppPage } from "./app-agent-protocol";
import { registerCustomer } from "./auth";
import { getSessionModel, setSessionModel } from "./model-settings";
import { createHash } from "node:crypto";

// Real Deep Agents loop and PostgreSQL checkpoints; only the model transport is fake.
vi.mock("./app-agent-harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./app-agent-harness")>();
  const { ChatOpenAI } = await import("@langchain/openai");
  return { ...actual, createAppAgentHarness: (saver: Parameters<typeof actual.createAppAgentHarness>[0], _override?: unknown, selected?: string) => {
    const model = new ChatOpenAI({ model: selected ?? "bank-db-test", apiKey: "test-only", maxRetries: 0, configuration: {
      baseURL: "https://test.invalid/v1", fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        const count = request.messages.filter((message: { role: string }) => message.role === "tool").length;
        const name = count === 0 ? "inspect_page" : "ask_user";
        const args = count === 0 ? {} : { question: "需要查看哪张卡？", options: ["日常卡", "旅行卡"] };
        return new Response(JSON.stringify({ id: "db-completion", object: "chat.completion", created: 1, model: "bank-db-test",
          choices: [{ index: 0, finish_reason: count < 2 ? "tool_calls" : "stop", message: count < 2
            ? { role: "assistant", content: "", tool_calls: [{ id: `call_${count}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
            : { role: "assistant", content: "已记录选择，未执行银行业务。" } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }), { headers: { "Content-Type": "application/json" } });
      },
    } });
    return actual.createAppAgentHarness(saver, model);
  } };
});

describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("visible Agent database and session boundary", () => {
  const customerId = randomUUID();
  const owner = { customerId, sessionHash: "test-session-a" };
  const page: AppPage = { name: "首页", version: "p1", text: "测试账户", controls: [] };
  const outcome = { status: "OBSERVED" as const, message: "已读取", page };
  const runIds: string[] = [];
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    vi.stubEnv("AI_BASE_URL", "https://test.invalid/v1");
    vi.stubEnv("AI_API_KEY", "test-only");
    vi.stubEnv("AI_MODEL", "bank-db-test");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ data: [{ id: "bank-db-test" }, { id: "bank-db-alternate" }] })));
    await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Visible Agent test',$2)", [customerId, randomUUID()]);
  });
  afterAll(async () => {
    // Only this suite's fixtures and checkpoint threads are removed.
    for (const table of ["checkpoint_writes", "checkpoint_blobs", "checkpoints"]) {
      if (runIds.length) await query(`DELETE FROM langgraph.${table} WHERE thread_id=ANY($1::text[])`, [runIds]);
    }
    await query("DELETE FROM audit_events WHERE customer_id=$1", [customerId]);
    await query("DELETE FROM app_agent_runs WHERE customer_id=$1", [customerId]);
    await query("DELETE FROM customers WHERE id=$1", [customerId]);
    await db.end();
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
  });
  it("requires control consent, persists pauses and never interprets a choice as bank authorization", async () => {
    const started = await startAppAgent(owner, "看看我的卡片", page);
    runIds.push(started.id);
    expect(started).toMatchObject({ status: "CONSENT", controlGranted: false, pending: { action: { type: "inspect" } } });
    await expect(controlAppAgent(owner, started.id, "advance", started.pending!.id, outcome)).rejects.toThrow("APP_AGENT_CONTROL_REQUIRED");
    await controlAppAgent(owner, started.id, "allow");
    await controlAppAgent(owner, started.id, "pause");
    expect(await getAppAgentRun(owner, started.id)).toMatchObject({ status: "PAUSED", controlGranted: true });
    await expect(controlAppAgent(owner, started.id, "advance", started.pending!.id, outcome)).rejects.toThrow("APP_AGENT_STATE_CHANGED");
    const question = await controlAppAgent(owner, started.id, "refresh", started.pending!.id, { ...outcome, status: "USER_CHANGED", page: { ...page, name: "卡片管理", version: "p2" } });
    expect(question.status).toBe("QUESTION");
    await expect(controlAppAgent(owner, started.id, "advance", started.pending!.id, outcome)).rejects.toThrow("APP_AGENT_STATE_CHANGED");
    const completed = await controlAppAgent(owner, started.id, "advance", question.pending!.id, { ...outcome, status: "USER_ANSWERED", message: "日常卡" });
    expect(completed.status).toBe("COMPLETED");
    expect((await query("SELECT count(*)::int AS count FROM audit_events WHERE customer_id=$1 AND event_type NOT LIKE 'APP_AGENT_%'", [customerId])).rows[0].count).toBe(0);
    const observed = await query("SELECT evidence FROM audit_events WHERE customer_id=$1 AND event_type='APP_AGENT_OBSERVATION'", [customerId]);
    expect(observed.rows).toHaveLength(2);
    expect(observed.rows.every((row) => row.evidence.bankExecutionVerified === false && row.evidence.source === "UNTRUSTED_CLIENT")).toBe(true);
  });
  it("rejects other customers, new login sessions, expired runs and simultaneous writers", async () => {
    const started = await startAppAgent(owner, "查询", page);
    runIds.push(started.id);
    await expect(getAppAgentRun({ ...owner, customerId: randomUUID() }, started.id)).rejects.toThrow("APP_AGENT_NOT_FOUND");
    await expect(controlAppAgent({ ...owner, sessionHash: "test-session-b" }, started.id, "allow")).rejects.toThrow("APP_AGENT_NOT_FOUND");
    const locker = await db.connect();
    try {
      await locker.query("SELECT pg_advisory_lock(hashtext($1))", [started.id]);
      await expect(controlAppAgent(owner, started.id, "allow")).rejects.toThrow("APP_AGENT_BUSY");
    } finally { await locker.query("SELECT pg_advisory_unlock(hashtext($1))", [started.id]); locker.release(); }
    await query("UPDATE app_agent_runs SET expires_at=now()-interval '1 second' WHERE id=$1", [started.id]);
    await expect(controlAppAgent(owner, started.id, "allow")).rejects.toThrow("APP_AGENT_EXPIRED");
  });
  it("enforces a customer-wide start limit across login sessions", async () => {
    await query("INSERT INTO app_agent_runs(id,customer_id,session_hash) SELECT gen_random_uuid(),$1,'another-session' FROM generate_series(1,10)", [customerId]);
    await expect(startAppAgent({ ...owner, sessionHash: "yet-another-session" }, "查询", page)).rejects.toThrow("APP_AGENT_RATE_LIMIT");
  });

  it("pins the selected model across refreshes while session preferences remain isolated", async () => {
    const person = await registerCustomer({ displayName: "Model settings fixture", phone: randomUUID(), password: "Test-only-123456" });
    const customer = person.customer.id;
    const tokenHash = createHash("sha256").update(person.token).digest("hex");
    const session = { customerId: customer, sessionTokenHash: tokenHash };
    const identity = { customerId: customer, sessionHash: "model-session" };
    const ids: string[] = [];
    try {
      expect(await getSessionModel(session)).toBe("bank-db-test");
      await setSessionModel(session, "bank-db-alternate");
      expect(await getSessionModel(session)).toBe("bank-db-alternate");
      const run = await startAppAgent(identity, "查看卡片", page, (await getSessionModel(session))!);
      ids.push(run.id);
      expect(run.model).toBe("bank-db-alternate");
      expect((await query("SELECT model FROM app_agent_runs WHERE id=$1", [run.id])).rows[0].model).toBe("bank-db-alternate");
      await setSessionModel(session, "bank-db-test");
      await controlAppAgent(identity, run.id, "allow");
      const next = await controlAppAgent(identity, run.id, "advance", run.pending!.id, outcome);
      expect(next.model).toBe("bank-db-alternate");
      expect((await getAppAgentRun(identity, run.id)).model).toBe("bank-db-alternate");
      const fresh = await startAppAgent(identity, "查看卡片", page, (await getSessionModel(session))!);
      ids.push(fresh.id); expect(fresh.model).toBe("bank-db-test");
      await expect(setSessionModel({ ...session, sessionTokenHash: "another-session" }, "bank-db-test")).rejects.toThrow("SESSION_EXPIRED");
      await expect(setSessionModel({ ...session, customerId }, "bank-db-test")).rejects.toThrow("SESSION_EXPIRED");
      await expect(setSessionModel(session, "unlisted-model")).rejects.toThrow("AI_MODEL_NOT_AVAILABLE");
      expect(await getSessionModel(session)).toBe("bank-db-test");
    } finally {
      for (const table of ["checkpoint_writes", "checkpoint_blobs", "checkpoints"]) if (ids.length) await query(`DELETE FROM langgraph.${table} WHERE thread_id=ANY($1::text[])`, [ids]);
      await query("DELETE FROM app_agent_runs WHERE customer_id=$1", [customer]);
      await query("DELETE FROM audit_events WHERE customer_id=$1", [customer]);
      await query("DELETE FROM accounts WHERE customer_id=$1", [customer]);
      await query("DELETE FROM customers WHERE id=$1", [customer]);
    }
  });
});
