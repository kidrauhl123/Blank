import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { registerCustomer } from "./auth";
import { query } from "./db";
import type { SplitSpec, ToolSpec } from "./tool-spec";
import { createTool, getToolView, setToolSaved } from "./tool-store";
import { getLayout } from "./ui-store";

const PASSWORD = "Test-only-123456";
// 测试库可能同时跑着别的测试，手机号用单独的前缀。
const RUN = String(randomInt(0, 1000)).padStart(3, "0");
let phoneSeq = 0;
const testPhone = () => `1992${RUN}${String(++phoneSeq).padStart(4, "0")}`;
const suffix = () => randomUUID().slice(0, 6);
// 北京时间 2026-10-31 10:00：所有“最近 90 天”“这几天”都按它算。
const NOW = new Date("2026-10-31T02:00:00Z");

const created = { customers: [] as string[], owners: [] as string[] };
async function newCustomer(displayName: string) {
  const identity = await registerCustomer({ displayName, phone: testPhone(), password: PASSWORD });
  const id = identity.customer.id;
  created.customers.push(id);
  const account = (await query<{ id: string }>("SELECT id FROM accounts WHERE customer_id=$1 AND account_type='CHECKING'", [id])).rows[0];
  return { id, name: displayName, accountId: account.id };
}
async function newOwner() {
  const id = randomUUID();
  await query("INSERT INTO visitor_memory_owners(id,token_hash) VALUES($1,$2)", [id, randomBytes(32).toString("hex")]);
  created.owners.push(id);
  return id;
}
// 直接写一笔流水（金额为分，正数是收入，负数是支出），时间带北京时区。
async function record(accountId: string, merchant: string, category: string, amountMinor: number, occurredAt: string) {
  await query("INSERT INTO bank_transactions(account_id,merchant_name,category,amount_minor,occurred_at) VALUES($1,$2,$3,$4,$5::timestamptz)",
    [accountId, merchant, category, amountMinor, occurredAt]);
}
const slider: ToolSpec = { kind: "slider-simulator", title: "冰岛基金", goalLabel: "冰岛", targetYuan: 50_000, savedYuan: 0, sliderMaxYuan: 2000, stepYuan: 100 };
const split = (over: Partial<SplitSpec> = {}): SplitSpec => ({ kind: "split-table", title: "成都旅行分账", friend: "小橘", from: "2026-10-10", to: "2026-10-11", ...over });
const rowsOf = (view: Awaited<ReturnType<typeof getToolView>>) => (view && view.kind === "split-table" ? view.rows.map(row => [row.date, row.label, row.amountMinor]) : []);

async function cleanup() {
  const customers = created.customers;
  if (customers.length > 0) {
    // 只删本文件造的数据：流水都落在本文件的客户账户上。
    const ourAccounts = "SELECT id FROM accounts WHERE customer_id=ANY($1::uuid[])";
    await query(`DELETE FROM bank_transactions WHERE account_id IN (${ourAccounts})`, [customers]);
    await query("DELETE FROM interactive_tools WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM ui_layouts WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM audit_events WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM accounts WHERE customer_id=ANY($1::uuid[])", [customers]);
    await query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [customers]);
  }
  if (created.owners.length > 0) await query("DELETE FROM visitor_memory_owners WHERE id=ANY($1::uuid[])", [created.owners]);
}

describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("小工具的账本计算与保存（真实数据库）", () => {
  afterAll(cleanup);

  it("滑块：每月结余 = 最近 90 天流水之和（不含理财）÷ 3，只读付款人自己的账户", async () => {
    const payer = await newCustomer(`付款人${suffix()}`);
    const other = await newCustomer(`别人${suffix()}`);
    const owner = await newOwner();
    const toolId = await createTool(payer.id, owner, slider);
    const before = await getToolView(payer.id, owner, toolId, NOW);
    await record(payer.accountId, "工资", "工资", 300_000, "2026-10-01T10:00:00+08:00");
    await record(payer.accountId, "超市", "购物", -120_000, "2026-10-05T10:00:00+08:00");
    await record(payer.accountId, "基金申购", "理财", -600_000, "2026-10-06T10:00:00+08:00"); // 理财视为储蓄，不算花掉的钱
    await record(payer.accountId, "很久以前", "购物", -999_999, "2026-06-01T10:00:00+08:00"); // 超出 90 天
    await record(other.accountId, "别人的消费", "购物", -777_777, "2026-10-05T10:00:00+08:00"); // 别人的账户
    const after = await getToolView(payer.id, owner, toolId, NOW);
    const baseline = before?.kind === "slider-simulator" ? before.base.monthlyNetMinor : NaN;
    // (300000 - 120000) / 3 = 60000
    expect(after).toMatchObject({ kind: "slider-simulator", base: { monthlyNetMinor: baseline + 60_000, monthsObserved: 3 } });
  });

  it("分账表：按北京时间的日期窗口列出支出；转账、理财、工资不列；朋友转给我的钱单独算", async () => {
    const payer = await newCustomer(`付款人${suffix()}`);
    const friend = await newCustomer(`小橘${suffix()}`);
    const owner = await newOwner();
    await record(payer.accountId, "海底捞", "餐饮", -12_800, "2026-10-10T19:00:00+08:00");
    await record(payer.accountId, "滴滴出行", "交通", -3_000, "2026-10-11T23:59:00+08:00"); // 窗口最后一分钟，算在内
    await record(payer.accountId, "优衣库", "购物", -9_900, "2026-10-12T00:00:00+08:00"); // 窗口之后，不算
    await record(payer.accountId, "转给朋友", "转账", -5_000, "2026-10-10T20:00:00+08:00"); // 转账不列
    await record(payer.accountId, "基金", "理财", -8_000, "2026-10-10T21:00:00+08:00"); // 理财不列
    await record(payer.accountId, `来自${friend.name}的转账`, "转账", 4_500, "2026-10-10T22:00:00+08:00");
    const toolId = await createTool(payer.id, owner, split({ friend: friend.name }));
    const view = await getToolView(payer.id, owner, toolId, NOW);
    expect(view).toMatchObject({ kind: "split-table", friendFound: true, receivedMinor: 4_500 });
    expect(rowsOf(view)).toEqual([["2026-10-10", "海底捞", 12_800], ["2026-10-11", "滴滴出行", 3_000]]);
  });

  it("分类与关键词筛选；关键词里的 % 是普通字符，不当通配符", async () => {
    const payer = await newCustomer(`付款人${suffix()}`);
    const owner = await newOwner();
    await record(payer.accountId, "海底捞", "餐饮", -12_800, "2026-10-10T19:00:00+08:00");
    await record(payer.accountId, "滴滴出行", "交通", -3_000, "2026-10-11T10:00:00+08:00");
    const food = await createTool(payer.id, owner, split({ categories: ["餐饮"] }));
    const byName = await createTool(payer.id, owner, split({ keywords: ["滴"] }));
    const percent = await createTool(payer.id, owner, split({ keywords: ["%"] }));
    expect(rowsOf(await getToolView(payer.id, owner, food, NOW))).toEqual([["2026-10-10", "海底捞", 12_800]]);
    expect(rowsOf(await getToolView(payer.id, owner, byName, NOW))).toEqual([["2026-10-11", "滴滴出行", 3_000]]);
    expect(rowsOf(await getToolView(payer.id, owner, percent, NOW))).toEqual([]);
  });

  it("朋友不存在时 friendFound 为 false，收到的钱为 0", async () => {
    const payer = await newCustomer(`付款人${suffix()}`);
    const owner = await newOwner();
    const toolId = await createTool(payer.id, owner, split({ friend: "没有这个人" }));
    expect(await getToolView(payer.id, owner, toolId, NOW)).toMatchObject({ friendFound: false, receivedMinor: 0 });
  });

  it("只能读到自己的小工具：别的访客或别的客户一律当作不存在", async () => {
    const payer = await newCustomer(`付款人${suffix()}`);
    const owner = await newOwner();
    const stranger = await newOwner();
    const outsider = await newCustomer(`别人${suffix()}`);
    const toolId = await createTool(payer.id, owner, slider);
    expect(await getToolView(payer.id, stranger, toolId, NOW)).toBeNull();
    expect(await getToolView(outsider.id, owner, toolId, NOW)).toBeNull();
    await expect(setToolSaved(payer.id, stranger, toolId, true)).rejects.toThrow("TOOL_NOT_FOUND");
  });

  it("保存到首页：写入 saved_at 和首页布局（放在资产卡之后，不重复）；移出首页只去掉这个区块", async () => {
    const payer = await newCustomer(`付款人${suffix()}`);
    const owner = await newOwner();
    const toolId = await createTool(payer.id, owner, slider);
    await setToolSaved(payer.id, owner, toolId, true);
    await setToolSaved(payer.id, owner, toolId, true);
    expect(await getToolView(payer.id, owner, toolId, NOW)).toMatchObject({ saved: true });
    const home = (await getLayout(payer.id, owner)).layout.home;
    expect(home[0]).toEqual({ type: "assets" });
    expect(home[1]).toEqual({ type: "tool", toolId });
    expect(home.filter(section => section.type === "tool")).toHaveLength(1);
    await setToolSaved(payer.id, owner, toolId, false);
    expect(await getToolView(payer.id, owner, toolId, NOW)).toMatchObject({ saved: false });
    expect((await getLayout(payer.id, owner)).layout.home.some(section => section.type === "tool")).toBe(false);
  });
});
