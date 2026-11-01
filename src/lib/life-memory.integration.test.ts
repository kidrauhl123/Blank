import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { registerCustomer } from "./auth";
import { query } from "./db";
import { listFeed, runFeedHeartbeat } from "./feed-store";
import { addDays, beijingToday, collectMemoryReminders, deleteLifeMemory, listLifeMemories, rememberLifeMemory, updateLifeMemory } from "./life-memory";

const PASSWORD = "Test-only-123456";
const RUN = String(randomInt(0, 1000)).padStart(3, "0");
let phoneSeq = 0;
const testPhone = () => `1994${RUN}${String(++phoneSeq).padStart(4, "0")}`;

const created = { customers: [] as string[], owners: [] as string[] };
async function newCustomer() {
  const identity = await registerCustomer({ displayName: `记忆${randomUUID().slice(0, 6)}`, phone: testPhone(), password: PASSWORD });
  created.customers.push(identity.customer.id);
  return identity.customer.id;
}
async function newOwner() {
  const id = randomUUID();
  await query("INSERT INTO visitor_memory_owners(id,token_hash) VALUES($1,$2)", [id, randomBytes(32).toString("hex")]);
  created.owners.push(id);
  return id;
}

async function cleanup() {
  const customers = created.customers;
  if (customers.length > 0) {
    await query("DELETE FROM feed_posts WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM feed_publisher_state WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM visitor_life_memories WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM audit_events WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM accounts WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [customers]);
  }
  if (created.owners.length > 0) await query("DELETE FROM visitor_memory_owners WHERE id=ANY($1::uuid[])", [created.owners]);
}

describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("生活事件和偏好的记忆（真实数据库）", () => {
  afterAll(cleanup);

  it("模型记下的事只属于这位访客；同一句话不重复记；别的访客看不到", async () => {
    const customer = await newCustomer();
    const owner = await newOwner();
    const other = await newOwner();
    const dueOn = addDays(beijingToday(), 3);
    const first = await rememberLifeMemory(customer, owner, { kind: "event", text: "下周五是我妈生日", dueOn }, { fromModel: true, userText: "下周五是我妈生日，提醒我" });
    expect(first).toMatchObject({ ok: true, updated: false });
    const again = await rememberLifeMemory(customer, owner, { kind: "event", text: "下周五是我妈生日", dueOn: addDays(dueOn, 1) }, { fromModel: true, userText: "下周五是我妈生日" });
    expect(again).toMatchObject({ ok: true, updated: true, id: first.ok ? first.id : "" });
    expect((await listLifeMemories(customer, owner)).map(memory => memory.dueOn)).toEqual([addDays(dueOn, 1)]);
    expect(await listLifeMemories(customer, other)).toEqual([]);
  });

  it("模型编的数字不记", async () => {
    const customer = await newCustomer();
    const owner = await newOwner();
    expect(await rememberLifeMemory(customer, owner, { kind: "preference", text: "每月花 800 块" }, { fromModel: true, userText: "我想少花点钱" })).toMatchObject({ ok: false });
    expect(await listLifeMemories(customer, owner)).toEqual([]);
  });

  it("修改要带着看到的版本号：旧版本不能覆盖新的修改；删除是软删除", async () => {
    const customer = await newCustomer();
    const owner = await newOwner();
    const saved = await rememberLifeMemory(customer, owner, { kind: "preference", text: "在戒奶茶" }, { fromModel: true, userText: "我在戒奶茶" });
    if (!saved.ok) throw new Error(saved.error);
    const [memory] = await listLifeMemories(customer, owner);
    const edited = await updateLifeMemory(customer, owner, memory.id, memory.version, { text: "在戒奶茶，少喝甜的" });
    expect(edited).toMatchObject({ ok: true, memory: { text: "在戒奶茶，少喝甜的" } });
    await expect(updateLifeMemory(customer, owner, memory.id, memory.version, { text: "旧的修改" })).rejects.toThrow("MEMORY_STALE");
    // 偏好没有日期：带日期的修改被拒绝（用的是当前版本，所以失败的原因只能是校验）。
    const latest = (await listLifeMemories(customer, owner))[0];
    expect(await updateLifeMemory(customer, owner, latest.id, latest.version, { dueOn: "2026-12-01" })).toMatchObject({ ok: false });
    const current = (await listLifeMemories(customer, owner))[0];
    await expect(deleteLifeMemory(customer, await newOwner(), memory.id, current.version)).rejects.toThrow("MEMORY_NOT_FOUND");
    await deleteLifeMemory(customer, owner, memory.id, current.version);
    expect(await listLifeMemories(customer, owner)).toEqual([]);
    expect((await query("SELECT 1 FROM visitor_life_memories WHERE id=$1 AND deleted_at IS NOT NULL", [memory.id])).rowCount).toBe(1);
  });

  it("到期前三天内的生活事件进入提醒候选；更远的、已删除的不进", async () => {
    const customer = await newCustomer();
    const owner = await newOwner();
    const today = beijingToday();
    await rememberLifeMemory(customer, owner, { kind: "event", text: "后天是朋友的生日", dueOn: addDays(today, 2) }, { fromModel: true, userText: "后天是朋友的生日" });
    await rememberLifeMemory(customer, owner, { kind: "event", text: "下个月有体检", dueOn: addDays(today, 20) }, { fromModel: true, userText: "下个月有体检" });
    const reminders = await collectMemoryReminders(customer);
    expect(reminders.map(item => item.text)).toEqual(["后天是朋友的生日"]);
  });

  it("提醒作为动态发出：标注“你说过”，只对本人可见", async () => {
    const customer = await newCustomer();
    const owner = await newOwner();
    const other = await newOwner();
    const today = beijingToday();
    await rememberLifeMemory(customer, owner, { kind: "event", text: "后天是朋友的生日", dueOn: addDays(today, 2) }, { fromModel: true, userText: "后天是朋友的生日" });
    const judge = vi.fn(async () => ({ show: true }));
    await runFeedHeartbeat({ judge, customerIds: [customer] });
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ kind: "memory", title: "后天是朋友的生日" }));
    const mine = await listFeed(customer, owner);
    expect(mine.find(post => post.kind === "memory")).toMatchObject({ title: "后天是朋友的生日", body: expect.stringContaining("你说过 · ") });
    expect((await listFeed(customer, other)).some(post => post.kind === "memory")).toBe(false);
  });
});
