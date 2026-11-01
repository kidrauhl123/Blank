import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentBankMonth } from "./banking-report";
import { db, query } from "./db";
import { listFeed } from "./feed-store";
import { createScheduledTask, tickScheduledTasks } from "./scheduled-tasks";
import { previewSchedule } from "./schedule-chat";

// Opt in only against a disposable PostgreSQL cluster (all migrations applied).
describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("预算提醒（真实数据库）", () => {
  const customer = randomUUID(), account = randomUUID(), owner = randomUUID();
  const month = currentBankMonth();
  const tomorrow = () => new Date(Date.now() + 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 10);
  const budget = (budgetCapMinor: number, budgetCategory = "餐饮") => ({
    requestKey: randomUUID(), kind: "BUDGET_CHECK", title: `${budgetCategory}预算提醒`, message: "", frequency: "DAILY",
    startsAt: new Date(Date.now() + 3_600_000).toISOString(), endsAt: null, channelIdentityId: null, budgetCategory, budgetCapMinor, confirmed: true,
  });
  async function due(id: string) { await query("UPDATE scheduled_tasks SET starts_at=now()-interval '1 minute',next_run_at=now()-interval '1 minute' WHERE id=$1", [id]); }
  const schedulePosts = async () => (await listFeed(customer, owner)).filter(post => post.kind === "schedule");

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database");
    await query("INSERT INTO customers(id,display_name,phone) VALUES($1,'Budget test',$2)", [customer, randomUUID()]);
    await query("INSERT INTO accounts(id,customer_id,name,account_type,masked_no) VALUES($1,$2,'Budget','CHECKING','TEST')", [account, customer]);
    await query("INSERT INTO visitor_memory_owners(id,token_hash) VALUES($1,$2)", [owner, randomBytes(32).toString("hex")]);
    // 本月 2 号中午（北京时间）的一笔餐饮支出：45 元。
    await query("INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at) VALUES($1,'聚餐店','餐饮',-4500,$2)", [account, `${month}-02T04:00:00Z`]);
  });
  afterAll(async () => {
    await query("DELETE FROM feed_posts WHERE customer_id=$1", [customer]);
    await query("DELETE FROM feed_publisher_state WHERE customer_id=$1", [customer]);
    await query("DELETE FROM scheduled_task_runs WHERE schedule_id IN (SELECT id FROM scheduled_tasks WHERE customer_id=$1)", [customer]);
    await query("DELETE FROM scheduled_tasks WHERE customer_id=$1", [customer]);
    await query("DELETE FROM audit_events WHERE customer_id=$1", [customer]);
    await query("DELETE FROM bank_transactions WHERE account_id=$1", [account]);
    await query("DELETE FROM accounts WHERE id=$1", [account]);
    await query("DELETE FROM visitor_memory_owners WHERE id=$1", [owner]);
    await query("DELETE FROM customers WHERE id=$1", [customer]);
    await db.end();
  });

  it("花到上限的 80% 时发一次动态提醒，同一个月不重复提醒", async () => {
    const task = await createScheduledTask(customer, budget(5000), { ownerId: owner });
    await due(task.id);
    await tickScheduledTasks();
    const first = await query<{ summary: string; status: string }>("SELECT summary,status FROM scheduled_task_runs WHERE schedule_id=$1", [task.id]);
    expect(first.rows).toEqual([{ summary: expect.stringContaining("已超过上限的 80% 提醒线"), status: "SUCCEEDED" }]);
    expect(first.rows[0].summary).toContain("餐饮本月已花 ¥45.00，上限 ¥50.00");
    expect(await schedulePosts()).toEqual([expect.objectContaining({ title: "餐饮预算提醒" })]);
    expect((await query("SELECT budget_alert_month FROM scheduled_tasks WHERE id=$1", [task.id])).rows[0].budget_alert_month).toBe(month);

    await due(task.id);
    await tickScheduledTasks();
    const again = await query<{ summary: string }>("SELECT summary FROM scheduled_task_runs WHERE schedule_id=$1 ORDER BY scheduled_for DESC LIMIT 1", [task.id]);
    expect(again.rows[0].summary).toContain("本月已经提醒过");
    expect(await schedulePosts()).toHaveLength(1);
  });

  it("没到提醒线时只留下运行记录，不发动态", async () => {
    const task = await createScheduledTask(customer, budget(20000), { ownerId: owner });
    await due(task.id);
    await tickScheduledTasks();
    const runs = await query<{ summary: string; status: string }>("SELECT summary,status FROM scheduled_task_runs WHERE schedule_id=$1", [task.id]);
    expect(runs.rows).toEqual([{ summary: expect.stringContaining("还没到提醒线"), status: "SUCCEEDED" }]);
    expect((await query("SELECT budget_alert_month FROM scheduled_tasks WHERE id=$1", [task.id])).rows[0].budget_alert_month).toBeNull();
    expect(await schedulePosts()).toHaveLength(1);
  });

  it("预算提醒必须有分类和上限，并且只能按天；其他任务不能带预算字段", async () => {
    await expect(createScheduledTask(customer, { ...budget(5000), budgetCategory: null })).rejects.toThrow();
    await expect(createScheduledTask(customer, { ...budget(5000), frequency: "WEEKLY" })).rejects.toThrow();
    await expect(createScheduledTask(customer, { ...budget(5000), kind: "REMINDER", message: "提醒", title: "提醒" })).rejects.toThrow();
  });

  it("在对话里预览：上限按元保存为分，非预算提醒不带分类", async () => {
    const preview = await previewSchedule(customer, owner, { kind: "BUDGET_CHECK", title: "交通预算提醒", frequency: "ONCE", firstDate: tomorrow(), time: "09:00", budgetCategory: "交通", budgetCapYuan: 300 });
    expect(preview).toMatchObject({ marker: expect.stringMatching(/^\[\[schedule:/) });
    const scheduleId = (preview as { scheduleId: string }).scheduleId;
    expect((await query("SELECT kind,frequency,budget_category,budget_cap_minor::text AS cap,status FROM scheduled_tasks WHERE id=$1", [scheduleId])).rows[0])
      .toEqual({ kind: "BUDGET_CHECK", frequency: "DAILY", budget_category: "交通", cap: "30000", status: "DRAFT" });
    expect(await previewSchedule(customer, owner, { kind: "BUDGET_CHECK", title: "交通预算提醒", frequency: "DAILY", firstDate: tomorrow(), time: "09:00", budgetCategory: "交通" }))
      .toMatchObject({ error: expect.stringContaining("上限") });
  });
});
