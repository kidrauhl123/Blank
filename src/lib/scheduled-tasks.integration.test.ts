import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, query, withTransaction } from "./db";
import { createSession } from "./auth";
import { createScheduledTask, listScheduledTasks, changeScheduledTask, tickScheduledTasks } from "./scheduled-tasks";
import { GET, POST, PATCH } from "../app/api/v1/schedules/route";

describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("persistent scheduled tasks", () => {
  const owner = randomUUID(), stranger = randomUUID(), account = randomUUID(), identity = randomUUID();
  let session = "";
  const base = () => ({ requestKey: randomUUID(), kind: "REMINDER", title: "账单提醒", message: "看账单", frequency: "ONCE", startsAt: new Date(Date.now() + 3_600_000).toISOString(), confirmed: true });
  async function due(id: string) { await query("UPDATE scheduled_tasks SET starts_at=now()-interval '1 minute',next_run_at=now()-interval '1 minute' WHERE id=$1", [id]); }
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database");
    await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Scheduler test',$3),($2,'Other',$4)", [owner, stranger, randomUUID(), randomUUID()]);
    await query("INSERT INTO accounts(id,customer_id,name,account_type,masked_no) VALUES($1,$2,'Schedule test','CHECKING','TEST')", [account, owner]);
    await query("INSERT INTO channel_identities(id,customer_id,channel_type,tenant_hash,subject_hash,subject_ciphertext) VALUES($1,$2,'QQ',$3,$4,'fixture')", [identity, owner, randomUUID(), randomUUID()]);
    session = (await createSession(owner)).token;
  });
  afterAll(async () => { await db.end(); });

  it("creates idempotently and isolates task ownership and channel bindings", async () => {
    const input = base();
    const pair = await Promise.all([createScheduledTask(owner, input), createScheduledTask(owner, input)]);
    expect(pair[0].id).toBe(pair[1].id);
    await expect(changeScheduledTask(stranger, pair[0].id, "cancel")).rejects.toThrow("SCHEDULE_NOT_FOUND");
    await expect(createScheduledTask(stranger, { ...base(), channelIdentityId: identity })).rejects.toThrow("CHANNEL_IDENTITY_NOT_FOUND");
    expect((await listScheduledTasks(stranger)).tasks).toHaveLength(0);
    await expect(createScheduledTask(owner, { ...base(), startsAt: "2020-01-01T00:00:00Z" })).rejects.toThrow("SCHEDULE_START_INVALID");
  });
  it("executes only due tasks once under competing ticks and records one outbox event", async () => {
    const task = await createScheduledTask(owner, { ...base(), channelIdentityId: identity });
    const future = await createScheduledTask(owner, base());
    await due(task.id);
    const balances = (await query("SELECT id,available_balance_minor FROM accounts ORDER BY id")).rows;
    await Promise.all([tickScheduledTasks(), tickScheduledTasks(), tickScheduledTasks()]);
    const result = await listScheduledTasks(owner);
    expect(result.tasks.find(item => item.id === task.id)?.status).toBe("COMPLETED");
    expect(result.tasks.find(item => item.id === future.id)?.status).toBe("ACTIVE");
    expect(result.runs.filter(item => item.schedule_id === task.id)).toHaveLength(1);
    const outbox = await query("SELECT payload FROM channel_outbox WHERE customer_id=$1", [owner]);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].payload.message).not.toContain("看账单");
    expect(result.scheduler.running).toBe(true);
    expect((await query("SELECT id,available_balance_minor FROM accounts ORDER BY id")).rows).toEqual(balances);
  });
  it("pauses, cancels, resumes and skips backlog without losing recurrence", async () => {
    const task = await createScheduledTask(owner, { ...base(), frequency: "DAILY" });
    await due(task.id);
    await changeScheduledTask(owner, task.id, "pause");
    await tickScheduledTasks();
    expect((await listScheduledTasks(owner)).runs.filter(item => item.schedule_id === task.id)).toHaveLength(0);
    const resumed = await changeScheduledTask(owner, task.id, "resume");
    expect(resumed.next_run_at.getTime()).toBeGreaterThan(Date.now());
    await due(task.id);
    await tickScheduledTasks();
    const active = (await listScheduledTasks(owner)).tasks.find(item => item.id === task.id)!;
    expect(active.status).toBe("ACTIVE");
    expect(active.next_run_at.getTime()).toBeGreaterThan(Date.now());
    await changeScheduledTask(owner, task.id, "cancel");
    await due(task.id);
    await tickScheduledTasks();
    expect((await listScheduledTasks(owner)).runs.filter(item => item.schedule_id === task.id)).toHaveLength(1);
    await expect(changeScheduledTask(owner, task.id, "resume")).rejects.toThrow("SCHEDULE_NOT_ACTIVE");
  });
  it("produces a complete monthly ledger report and honors revoked notification bindings", async () => {
    const task = await createScheduledTask(owner, { ...base(), kind: "MONTHLY_REPORT", frequency: "MONTHLY", channelIdentityId: identity });
    await query("UPDATE scheduled_tasks SET starts_at='2026-09-30T16:00:00Z',next_run_at='2026-09-30T16:00:00Z' WHERE id=$1", [task.id]);
    await query("INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at) SELECT $1,'Test','转账',-100,'2026-09-10T00:00:00Z' FROM generate_series(1,60)", [account]);
    await query("UPDATE channel_identities SET status='REVOKED' WHERE id=$1", [identity]);
    await tickScheduledTasks();
    const run = (await listScheduledTasks(owner)).runs.find(item => item.schedule_id === task.id)!;
    expect(run.summary).toContain("2026-09"); expect(run.summary).toContain("60 笔"); expect(run.summary).toContain("¥60.00");
    expect(run.summary).toContain("不等同于消费支出"); expect(run.summary).toContain("绑定已失效"); expect(run.delivery).toBeNull();
    await changeScheduledTask(owner, task.id, "cancel");
  });
  it("ends expired schedules and saves quiet subscription checks", async () => {
    const expired = await createScheduledTask(owner, base()); await due(expired.id);
    await query("UPDATE scheduled_tasks SET ends_at=now()-interval '10 seconds' WHERE id=$1", [expired.id]);
    const check = await createScheduledTask(owner, { ...base(), kind: "SUBSCRIPTION_CHECK" }); await due(check.id);
    await tickScheduledTasks();
    const result = await listScheduledTasks(owner);
    expect(result.tasks.find(item => item.id === expired.id)?.status).toBe("COMPLETED");
    expect(result.runs.some(item => item.schedule_id === expired.id)).toBe(false);
    expect(result.runs.find(item => item.schedule_id === check.id)?.summary).toContain("没有到期记录");
  });
  it("reports upcoming subscriptions but excludes blocked and distant entries", async () => {
    const card = randomUUID();
    await query("INSERT INTO cards(id,customer_id,account_id,card_name,masked_no,card_type) VALUES($1,$2,$3,'Test','TEST','VIRTUAL')", [card, owner, account]);
    await query(`INSERT INTO subscriptions(customer_id,card_id,merchant_name,amount_minor,billing_cycle,next_charge_at,status) VALUES
      ($1,$2,'Due merchant',1900,'MONTHLY',now()+interval '1 day','ACTIVE'),
      ($1,$2,'Blocked merchant',900,'MONTHLY',now()+interval '1 day','BLOCKED'),
      ($1,$2,'Distant merchant',900,'MONTHLY',now()+interval '5 days','ACTIVE')`, [owner, card]);
    const task = await createScheduledTask(owner, { ...base(), kind: "SUBSCRIPTION_CHECK" }); await due(task.id);
    await tickScheduledTasks();
    const run = (await listScheduledTasks(owner)).runs.find(item => item.schedule_id === task.id)!;
    expect(run.summary).toContain("Due merchant ¥19.00");
    expect(run.summary).not.toContain("Blocked merchant");
    expect(run.summary).not.toContain("Distant merchant");
  });
  it("rolls back an abandoned claim and safely executes after recovery", async () => {
    const task = await createScheduledTask(owner, base()); await due(task.id);
    await expect(withTransaction(async client => {
      await client.query("SELECT id FROM scheduled_tasks WHERE id=$1 FOR UPDATE", [task.id]);
      await client.query("UPDATE scheduled_tasks SET status='COMPLETED' WHERE id=$1", [task.id]);
      throw new Error("simulated crash");
    })).rejects.toThrow("simulated crash");
    await tickScheduledTasks();
    expect((await listScheduledTasks(owner)).runs.filter(item => item.schedule_id === task.id)).toHaveLength(1);
  });
  it("retains retry state and stops after three failures without partial notification", async () => {
    const task = await createScheduledTask(owner, base()); await due(task.id);
    // Isolated test trigger makes the executor fail after generating the result.
    await query(`CREATE FUNCTION fail_schedule_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='SCHEDULE_EXECUTED' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER schedule_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_schedule_audit()`);
    try {
      for (let i = 0; i < 3; i++) {
        await query("UPDATE scheduled_tasks SET retry_at=NULL WHERE id=$1", [task.id]);
        await tickScheduledTasks();
      }
      const result = await listScheduledTasks(owner);
      expect(result.tasks.find(item => item.id === task.id)).toMatchObject({ status: "ERROR", attempts: 3 });
      expect(result.runs.filter(item => item.schedule_id === task.id)).toHaveLength(1);
      expect(result.runs.find(item => item.schedule_id === task.id)).toMatchObject({ status: "FAILED", attempts: 3 });
    } finally { await query("DROP TRIGGER schedule_failure ON audit_events; DROP FUNCTION fail_schedule_audit()"); }
    await changeScheduledTask(owner, task.id, "resume"); await tickScheduledTasks();
    expect((await listScheduledTasks(owner)).tasks.find(item => item.id === task.id)?.status).toBe("COMPLETED");
  });
  it("enforces session authentication, same origin and validation on HTTP routes", async () => {
    expect((await GET(new Request("http://localhost/api/v1/schedules"))).status).toBe(401);
    const headers = { cookie: `bankpilot_session=${session}`, "Content-Type": "application/json" };
    expect((await POST(new Request("http://localhost/api/v1/schedules", { method: "POST", headers: { ...headers, origin: "http://evil.test" }, body: JSON.stringify(base()) }))).status).toBe(403);
    const validHeaders = { ...headers, origin: "http://localhost" };
    expect((await POST(new Request("http://localhost/api/v1/schedules", { method: "POST", headers: validHeaders, body: JSON.stringify({ ...base(), confirmed: false }) }))).status).toBe(400);
    const created = await POST(new Request("http://localhost/api/v1/schedules", { method: "POST", headers: validHeaders, body: JSON.stringify(base()) }));
    expect(created.status).toBe(200);
    const { task } = await created.json();
    const changed = await PATCH(new Request("http://localhost/api/v1/schedules", { method: "PATCH", headers: validHeaders, body: JSON.stringify({ id: task.id, action: "cancel" }) }));
    expect(changed.status).toBe(200);
  });
});
