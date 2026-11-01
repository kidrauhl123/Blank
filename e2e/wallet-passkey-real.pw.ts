import { createHash, createHmac, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { beginTotpSetup, confirmTotpSetup } from "../src/lib/auth";
import { db, query } from "../src/lib/db";
import { createRuleDraft } from "../src/lib/wallet-store";
import { WALLET_CAPS } from "../src/lib/wallet-core";

const ORIGIN = "http://localhost:3109";

// 真实路径：真登录、真数据库、真服务端校验（TOTP 步进验证与 @simplewebauthn/server 的 WebAuthn 校验），浏览器端由虚拟认证器扮演手机的面容 / 指纹。
// 只有“助手的回复”是模拟的（本地没有模型）：它返回一个指向真实规矩草稿的标记。
test.skip(process.env.BANKPILOT_DEMO_E2E !== "1", "Requires the disposable database demo server");
test.afterAll(async () => { await db.end(); });

// 与服务端一致的 TOTP（RFC 6238，30 秒一步，6 位）。
function totpCode(secret: string, step: number) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret].map(char => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(value => parseInt(value, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  return ((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}
// 同一步的动态码只能用一次（服务端按步防重放）：等到下一步再取码。
async function codeAfter(secret: string, usedStep: number) {
  let step = Math.floor(Date.now() / 30_000);
  while (step <= usedStep) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    step = Math.floor(Date.now() / 30_000);
  }
  return totpCode(secret, step);
}

test("a real Passkey registration and assertion starts the cooling period; a covered transfer waits until then; another visitor cannot confirm it", async ({ page, context, browser }) => {
  test.setTimeout(120_000);
  // 北京时间深夜，规矩会拒绝覆盖转账（见 WALLET_RULES 第 5 节）。这个用例用真实时间，夜里跑没有意义；夜间行为由 wallet-core 的固定时间用例覆盖。
  const beijingHour = new Date(Date.now() + 8 * 3_600_000).getUTCHours();
  test.skip(beijingHour >= WALLET_CAPS.nightFromHour || beijingHour < WALLET_CAPS.nightToHour, "北京时间深夜规矩不覆盖转账，夜间规则由 wallet-core 单元测试覆盖");
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

  // 本地没有模型：界面要求模型已配置才能发送。这里只把这一个标记改成已配置，其余的数据都是真的。
  await page.route("**/api/bootstrap", async route => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, ai: { ...json.ai, configured: true } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "以小土豆进入" }).click();
  await expect(page.getByRole("button", { name: "Blank", exact: true })).toBeVisible();
  const token = (await context.cookies()).find(cookie => cookie.name === "bankpilot_memory_visitor")?.value;
  expect(token).toBeTruthy();
  const owner = (await query<{ id: string }>("SELECT id FROM visitor_memory_owners WHERE token_hash=$1", [createHash("sha256").update(token!).digest("hex")])).rows[0].id;
  const customer = (await query<{ customer_id: string; account_id: string }>("SELECT d.customer_id,a.id AS account_id FROM demo_profiles d JOIN accounts a ON a.customer_id=d.customer_id AND a.account_type='CHECKING' WHERE d.profile_key='potato' ORDER BY a.created_at LIMIT 1")).rows[0];

  // 注册 Passkey 前要先用验证器确认（step-up）：演示用户还没有验证器，这里在一次性数据库里为他建立一个。
  // 一次性数据库：先清掉上一次运行留下的验证器，否则 beginTotpSetup 会报 MFA_ALREADY_CONFIGURED。
  await query("DELETE FROM mfa_totp WHERE customer_id=$1", [customer.customer_id]);
  const { secret } = await beginTotpSetup(customer.customer_id);
  const enrolledStep = Math.floor(Date.now() / 30_000);
  await confirmTotpSetup(customer.customer_id, totpCode(secret, enrolledStep));

  // 小板栗需要是老联系人：老联系人按账本里的往来次数算（至少 2 次），预置数据里不够，这里在账本里补两笔往来。
  const friend = (await query<{ account_id: string }>("SELECT a.id AS account_id FROM customers c JOIN accounts a ON a.customer_id=c.id AND a.account_type='CHECKING' WHERE c.display_name='小板栗' ORDER BY a.created_at LIMIT 1")).rows[0];
  if (!friend) throw new Error("演示数据里没有小板栗");
  for (let i = 0; i < 2; i++) {
    const tx = (await query<{ id: string }>("INSERT INTO ledger_transactions(reference,transaction_type,description,posted_at) VALUES($1,'TRANSFER','测试往来',now()) RETURNING id", [`E2E-${randomUUID()}`])).rows[0];
    await query("INSERT INTO ledger_entries(ledger_transaction_id,account_id,amount_minor,direction) VALUES($1,$2,-1000,'DEBIT'),($1,$3,1000,'CREDIT')", [tx.id, customer.account_id, friend.account_id]);
  }
  const draft = await createRuleDraft(customer.customer_id, owner, { template: "pay_trusted_small", recipients: ["小板栗"], perTxnYuan: 100, monthlyYuan: 300 });
  if ("error" in draft) throw new Error(draft.error);

  await page.route("**/api/agent/app", route => route.fulfill({ json: { id: "00000000-0000-4000-8000-0000000000f1", status: "COMPLETED", pending: null, controlGranted: false, steps: 2, message: `请本人确认这条规矩：\n\n${draft.marker}` } }));
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "Blank" }).click();
  const conversation = page.getByRole("region", { name: "Blank 会话" });
  await conversation.getByRole("textbox", { name: "向 Blank 描述需求或回答问题" }).fill("以后给小板栗 100 块以内的转账不用问我");
  await conversation.getByRole("button", { name: "发送给 Blank" }).click();
  const card = conversation.getByRole("article", { name: /^规矩：/ });
  await expect(card).toContainText("小板栗");
  await expect(card).toContainText("单笔不超过");

  // 注册 Passkey：先输入当前验证器动态码，再由虚拟认证器完成面容 / 指纹。
  await card.getByRole("textbox", { name: "注册 Passkey 用的动态码" }).fill(await codeAfter(secret, enrolledStep));
  await card.getByRole("button", { name: "注册 Passkey（面容 / 指纹）" }).click();
  await expect(card.getByRole("button", { name: "用面容 / 指纹确认" })).toBeVisible();
  expect((await query("SELECT 1 FROM passkey_credentials WHERE owner_id=$1", [owner])).rowCount).toBe(1);
  // 确认前：规矩还是草稿。
  expect((await query<{ status: string }>("SELECT status FROM wallet_rules WHERE id=$1", [draft.ruleId])).rows[0].status).toBe("DRAFT");

  await card.getByRole("button", { name: "用面容 / 指纹确认" }).click();
  await expect(card).toContainText("将在");
  const rule = (await query<{ status: string; authorized_by: string; effective_at: Date; authorized_at: Date }>("SELECT status,authorized_by,effective_at,authorized_at FROM wallet_rules WHERE id=$1", [draft.ruleId])).rows[0];
  expect(rule).toMatchObject({ status: "COOLING", authorized_by: "PASSKEY" });
  expect(rule.effective_at.getTime() - rule.authorized_at.getTime()).toBe(24 * 3_600_000);
  expect((await query("SELECT 1 FROM feed_posts WHERE customer_id=$1 AND kind='rule' AND visitor_owner_id=$2 AND attention", [customer.customer_id, owner])).rowCount).toBeGreaterThan(0);

  // 钱包里放 ¥300（走真实的钱包接口），规矩内的转账才有钱可付。
  const fund = await page.request.post("/api/v1/wallet", { headers: { origin: ORIGIN }, data: { action: "fund", amountYuan: 300 } });
  expect(fund.status()).toBe(200);

  // 冷静期内：同样的转账走普通流程，需要用户确认，不会自动办理。
  const during = await page.request.post("/api/v1/transfers/prepare", { headers: { origin: ORIGIN }, data: { fromAccountId: customer.account_id, recipient: "小板栗", amountMinor: 8000 } });
  expect(during.status()).toBe(201);
  const duringBody = await during.json();
  expect(duringBody).not.toHaveProperty("viaRule");
  expect(duringBody.requiredAuth).not.toBe("NONE");

  // 运维跳过冷静期后（只为这条测试），同一笔由规矩自动办理：过账成功，并带上规矩标记。
  await query("UPDATE wallet_rules SET effective_at=now() - interval '1 minute' WHERE id=$1", [draft.ruleId]);
  const after = await page.request.post("/api/v1/transfers/prepare", { headers: { origin: ORIGIN }, data: { fromAccountId: customer.account_id, recipient: "小板栗", amountMinor: 8000 } });
  expect(after.status()).toBe(201);
  expect(await after.json()).toMatchObject({ status: "SUCCEEDED", viaRule: true, ruleId: draft.ruleId, requiredAuth: "NONE" });
  // 超过单笔上限的仍然照常确认，不自动办理。
  const over = await page.request.post("/api/v1/transfers/prepare", { headers: { origin: ORIGIN }, data: { fromAccountId: customer.account_id, recipient: "小板栗", amountMinor: 10_100 } });
  expect(over.status()).toBe(201);
  expect(await over.json()).not.toHaveProperty("viaRule");

  // 另一位访客拿不到、也确认不了这张卡。
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto("/");
  await otherPage.getByRole("button", { name: "以小土豆进入" }).click();
  await expect(otherPage.getByRole("button", { name: "Blank", exact: true })).toBeVisible();
  expect((await otherPage.request.get(`/api/v1/rules/${draft.ruleId}`)).status()).toBe(404);
  expect((await otherPage.request.post(`/api/v1/rules/${draft.ruleId}`, { headers: { origin: ORIGIN }, data: { action: "authorize", method: "totp", code: "123456" } })).status()).toBe(404);
  await other.close();
});
