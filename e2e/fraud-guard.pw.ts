import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { query } from "../src/lib/db";

test.skip(process.env.BANKPILOT_DEMO_E2E !== "1", "Requires the disposable database demo server");
// 演示账户是共用的：这里留下的话术记录会在 60 分钟内让同一账户的其他转账都被暂缓，所以用完就删，并取消这次被暂缓的草稿。
// 注意：不在这里结束连接池。同一个 worker 里的其他 e2e 文件还在用共用的 db，结束它会让它们报错。
test.afterAll(async () => {
  const potato = "(SELECT customer_id FROM demo_profiles WHERE profile_key='potato')";
  await query(`DELETE FROM app_agent_runs WHERE customer_id=${potato} AND start_text='对方让我把钱转到安全账户'`);
  await query(`UPDATE transfers SET status='CANCELLED' WHERE customer_id=${potato} AND status='AWAITING_AUTH' AND hold_until IS NOT NULL`);
});

// 反诈守护的真实路径：真登录、真数据库、真服务端判断。用户在对话里说过“安全账户”，然后在弹窗里发起转账：
// 应该出现拦截卡（说明原因、96110），选“24 小时后再办”后，这笔钱不会转出。
test("a transfer after a scam phrase in chat is held with a 96110 card, and nothing moves", async ({ page, context }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "以小土豆进入" }).click();
  await expect(page.getByRole("button", { name: "Blank", exact: true })).toBeVisible();
  const token = (await context.cookies()).find(cookie => cookie.name === "bankpilot_memory_visitor")?.value;
  expect(token).toBeTruthy();
  const customer = (await query<{ customer_id: string; account_id: string }>("SELECT d.customer_id,a.id AS account_id FROM demo_profiles d JOIN accounts a ON a.customer_id=d.customer_id AND a.account_type='CHECKING' WHERE d.profile_key='potato' ORDER BY a.created_at LIMIT 1")).rows[0];
  // 最近一小时用户自己说过的话里有“安全账户”：这是服务端判断暂缓的依据，不是模拟。
  await query("INSERT INTO app_agent_runs(id,customer_id,session_hash,start_text,start_source,created_at) VALUES(gen_random_uuid(),$1,$2,'对方让我把钱转到安全账户','typed',now())",
    [customer.customer_id, createHash("sha256").update(token!).digest("hex")]);
  const balanceBefore = (await query<{ balance: string }>("SELECT available_balance_minor::text AS balance FROM accounts WHERE id=$1", [customer.account_id])).rows[0].balance;

  await page.locator('[data-agent-id="open-transfer"]').click();
  const dialog = page.getByRole("dialog", { name: "发起转账" });
  await dialog.locator('[data-agent-id="field-recipient"]').fill("小板栗");
  await dialog.locator('[data-agent-id="field-amount"]').fill("10");
  await dialog.locator('[data-agent-id="prepare-transfer"]').click();

  const card = page.getByRole("alert", { name: "反诈守护拦截卡" });
  await expect(card).toContainText("先别急，这笔转账有点可疑");
  await expect(card).toContainText("96110");
  await expect(card).toContainText("出现了“安全账户”");
  await card.getByRole("radio", { name: "是" }).first().check();
  await card.getByRole("button", { name: "24 小时后再办" }).click();
  await expect(page.getByRole("dialog", { name: "核对转账" }).getByRole("status")).toContainText("已暂缓");

  // 暂缓之后不能确认，钱也没有动。
  await expect(page.getByRole("dialog", { name: "核对转账" }).locator('[data-agent-id="confirm-transfer"]')).toHaveCount(0);
  expect((await query<{ balance: string }>("SELECT available_balance_minor::text AS balance FROM accounts WHERE id=$1", [customer.account_id])).rows[0].balance).toBe(balanceBefore);
  expect((await query("SELECT 1 FROM transfers WHERE customer_id=$1 AND status='AWAITING_AUTH' AND hold_until IS NOT NULL", [customer.customer_id])).rowCount).toBeGreaterThan(0);
});
