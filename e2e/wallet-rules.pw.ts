import { expect, test, type Page } from "@playwright/test";

// 规矩卡的真实流程：用 Chromium 的虚拟认证器（模拟手机的面容/指纹）走 Passkey 注册和确认，
// 其余（助手提议、规矩数据）用接口模拟，因为这里测的是“只有用户本人在卡片上的点击能让规矩进入冷静期”。
const ruleId = "00000000-0000-4000-8000-0000000000e1";
const overview = {
  customer: { display_name: "测试客户", phone: "99000000011", demo: true, mfa_configured: false }, totalMinor: 500000,
  accounts: [{ id: "00000000-0000-4000-8000-000000000002", name: "活期账户", masked_no: "•• 1234", account_no: "test-only", currency: "CNY", status: "ACTIVE", available_balance_minor: "500000" }],
  cards: [], transactions: [], subscriptions: [], ai: { configured: true, model: "test-transport" },
  statement: { month: "2026-10", expenseMinor: 0, categories: [], transactionCount: 0 },
};
const lines = [{ label: "类型", value: "小额免确认付款" }, { label: "免确认的对象", value: "小橘子（有过多次往来的老联系人）" }, { label: "单笔不超过", value: "¥100" }, { label: "每月合计不超过", value: "¥300" },
  { label: "钱从哪里出", value: "只从 Blank 钱包里出，不动你的主账户" }, { label: "什么时候生效", value: "你本人验证后再等 24 小时（冷静期）" }];

async function openChat(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "Blank" }).click();
  const conversation = page.getByRole("region", { name: "Blank 会话" });
  await conversation.getByRole("textbox", { name: "向 Blank 描述需求或回答问题" }).fill("以后给小橘子 100 块以内的转账不用问我");
  await conversation.getByRole("button", { name: "发送给 Blank" }).click();
  return conversation;
}

test("a rule only enters its cooling period after the user's own Passkey confirmation, and the card shows server text", async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  let stage: "DRAFT" | "COOLING" | "REVOKED" = "DRAFT";
  let passkeys = 0;
  const posts: unknown[] = [];
  const view = () => ({ rule: { id: ruleId, stage, template: "小额免确认付款", lines, authorizedBy: stage === "DRAFT" ? null : "PASSKEY", effectiveAt: stage === "COOLING" ? new Date(Date.now() + 24 * 3_600_000).toISOString() : null,
    pausedReason: null, monthPaidMinor: 0, auth: { passkeys, totp: true } } });
  await page.route("**/api/bootstrap", route => route.fulfill({ json: overview }));
  await page.route("**/api/v1/feed", route => route.fulfill({ json: { posts: [] } }));
  await page.route("**/api/agent/app", route => route.fulfill({ json: { id: "00000000-0000-4000-8000-0000000000e2", status: "COMPLETED", pending: null, controlGranted: false, steps: 2, message: `这是你要立的规矩，请在卡片上本人确认：\n\n[[rule:${ruleId}]]` } }));
  await page.route(`**/api/v1/rules/${ruleId}`, async route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      posts.push(body);
      if (body.action === "authorize" && body.method === "passkey") { expect(body.response.id).toBeTruthy(); stage = "COOLING"; }
      if (body.action === "revoke") stage = "REVOKED";
      return route.fulfill({ json: { ok: true } });
    }
    await route.fulfill({ json: view() });
  });
  // 真实的 WebAuthn 挑战：这里用接口模拟服务端的选项，由浏览器的虚拟认证器真正签名。
  const challenge = Buffer.from("test-challenge-0123456789abcdef").toString("base64url");
  const rpId = new URL(page.url() === "about:blank" ? "http://localhost:3109" : page.url()).hostname;
  await page.route("**/api/v1/passkeys", async route => {
    const body = route.request().postDataJSON();
    posts.push(body);
    if (body.step === "register-options") return route.fulfill({ json: { challenge, rp: { name: "Blank", id: rpId }, user: { id: Buffer.from("owner").toString("base64url"), name: "测试", displayName: "测试" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], timeout: 60000, attestation: "none", authenticatorSelection: { residentKey: "preferred", userVerification: "required" } } });
    if (body.step === "register-verify") { passkeys = 1; return route.fulfill({ json: { ok: true } }); }
    await route.fulfill({ json: { challenge, timeout: 60000, rpId, userVerification: "required", allowCredentials: [] } });
  });
  const conversation = await openChat(page);
  const card = conversation.getByRole("article", { name: /^规矩：/ });
  await expect(card).toContainText("新规矩 · 等你本人确认");
  await expect(card).toContainText("小橘子（有过多次往来的老联系人）"); // 服务端渲染的文字
  await expect(card).toContainText("冷静期");
  await expect(conversation).not.toContainText("[[rule:");
  expect(posts.filter(item => (item as { action?: string }).action === "authorize")).toEqual([]); // 说了不算，点了才算
  // 第一次没有 Passkey：先注册（虚拟认证器完成面容/指纹），再确认。
  await card.getByRole("textbox", { name: "注册 Passkey 用的动态码" }).fill("123456");
  await card.getByRole("button", { name: "注册 Passkey（面容 / 指纹）" }).click();
  await expect(card.getByRole("button", { name: "用面容 / 指纹确认" })).toBeVisible();
  await card.getByRole("button", { name: "用面容 / 指纹确认" }).click();
  await expect(card).toContainText("将在");
  await expect(card).toContainText("生效");
  expect(posts.some(item => (item as { method?: string }).method === "passkey")).toBe(true);
  await card.getByRole("button", { name: "撤销这条规矩" }).click();
  await expect(card).toContainText("已撤销");
});

test("without Passkey the card falls back to the verifier code, rejects a wrong code and never starts the cooling period", async ({ page }) => {
  let stage: "DRAFT" | "COOLING" = "DRAFT";
  const attempts: string[] = [];
  await page.addInitScript(() => { Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true }); });
  await page.route("**/api/bootstrap", route => route.fulfill({ json: overview }));
  await page.route("**/api/v1/feed", route => route.fulfill({ json: { posts: [] } }));
  await page.route("**/api/agent/app", route => route.fulfill({ json: { id: "00000000-0000-4000-8000-0000000000e3", status: "COMPLETED", pending: null, controlGranted: false, steps: 2, message: `请本人确认：\n\n[[rule:${ruleId}]]` } }));
  await page.route(`**/api/v1/rules/${ruleId}`, async route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      attempts.push(body.code);
      if (body.code !== "123456") return route.fulfill({ status: 401, json: { message: "验证器动态码不对，请重试。", error: "MFA_INVALID" } });
      stage = "COOLING";
      return route.fulfill({ json: { ok: true } });
    }
    await route.fulfill({ json: { rule: { id: ruleId, stage, template: "小额免确认付款", lines, authorizedBy: stage === "COOLING" ? "TOTP" : null,
      effectiveAt: stage === "COOLING" ? new Date(Date.now() + 24 * 3_600_000).toISOString() : null, pausedReason: null, monthPaidMinor: 0, auth: { passkeys: 0, totp: true } } } });
  });
  const conversation = await openChat(page);
  const card = conversation.getByRole("article", { name: /^规矩：/ });
  await expect(card.getByRole("button", { name: /Passkey/ })).toHaveCount(0); // 浏览器不支持就不提供
  const input = card.getByRole("textbox", { name: "确认规矩用的动态码" });
  await input.fill("000000");
  await card.getByRole("button", { name: "改用验证器动态码" }).click();
  await expect(card.getByRole("alert")).toContainText("验证器动态码不对");
  await expect(card).toContainText("新规矩 · 等你本人确认"); // 仍是草稿，没有进入冷静期
  await input.fill("123456");
  await card.getByRole("button", { name: "改用验证器动态码" }).click();
  await expect(card).toContainText("生效");
  expect(attempts).toEqual(["000000", "123456"]);
});
