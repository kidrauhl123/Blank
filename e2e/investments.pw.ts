import { expect, test, type Page } from "@playwright/test";
import { investmentPriceSeries, type InvestmentRules } from "../src/lib/investment-model";

const accountId = "12100000-0000-4000-8000-000000000001";
const definitions = [
  ["零钱灵活", "FLEXIBLE", "R1", 10000, 0], ["日享灵活", "FLEXIBLE", "R2", 100000, 0],
  ["稳享 30 天", "HOLDING", "R2", 100000, 30], ["均衡 60 天", "HOLDING", "R3", 500000, 60],
  ["定享 90 天", "CLOSED", "R2", 100000, 90], ["远享 180 天", "CLOSED", "R3", 1000000, 180],
] as const;
const products = definitions.map(([name, kind, riskLevel, minimumMinor, holdingDays], index) => {
  const rules: InvestmentRules = { kind, holdingDays, seed: index + 101, driftBps: 200, volatilityBps: 10, purchaseFeeBps: 0, redemptionFeeBps: 0, epoch: "2026-01-01", modelVersion: "wealth-v1" };
  return { id: `02100000-0000-4000-8000-00000000000${index + 1}`, code: `SIM-${index + 1}`, name, issuer: "BankPilot", kind, riskLevel, minimumMinor, holdingDays,
    purchaseFeeBps: 0, redemptionFeeBps: 0, status: "OPEN", ...investmentPriceSeries(rules, "2026-10-22"), change30DaysPercent: 0.5, simulated: true, source: "比赛模拟" };
});
async function setup(page: Page) {
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    customer: { display_name: "理财测试", phone: "99000000001", mfa_configured: true }, totalMinor: 2000000,
    accounts: [{ id: accountId, name: "活期账户", masked_no: "•• 1234", available_balance_minor: "2000000", status: "ACTIVE", currency: "CNY" }],
    cards: [], transactions: [], subscriptions: [], ai: { configured: false, model: null },
    statement: { month: "2026-10", expenseMinor: 0, categories: [] },
  } }));
  await page.route("**/api/v1/investments", route => route.fulfill({ json: { businessDate: "2026-10-22", products, positions: [], cashMinor: 2000000, valueMinor: 0, profitMinor: 0, assessment: { riskLevel: "R3", expiresAt: "2027-10-22" } } }));
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "理财", exact: true }).click();
}

test("six products can be filtered, compared and opened without a bank write", async ({ page }) => {
  let writes = 0;
  page.on("request", request => { if (request.method() === "POST") writes++; });
  await setup(page);
  await expect(page.getByText("6 只符合条件")).toBeVisible();
  await page.getByRole("button", { name: "灵活申赎", exact: true }).click();
  await expect(page.getByText("2 只符合条件")).toBeVisible();
  await page.getByRole("button", { name: "加入对比", exact: true }).nth(0).click();
  await page.getByRole("button", { name: "加入对比", exact: true }).click();
  await page.getByRole("button", { name: "对比（2/3）", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "产品对比" })).toContainText("零钱灵活");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("可投入金额（元）").fill("1");
  await expect(page.getByText("0 只符合条件")).toBeVisible();
  await page.getByLabel("可投入金额（元）").fill("");
  await page.locator('[data-agent-id="wealth-product-SIM-1"]').click();
  await expect(page.getByRole("img", { name: /零钱灵活近30天净值走势/ })).toBeVisible();
  expect(writes).toBe(0);
});

test("preparing a subscription cannot submit money or expose OTP to the assistant", async ({ page }) => {
  await setup(page);
  let commits = 0;
  await page.route("**/api/v1/investments/orders", route => route.fulfill({ json: {
    operationId: "INV-ui-fixture", status: "AWAITING_AUTH", expiresAt: "2030-01-01T00:00:00Z", receipt: null,
    quote: { side: "SUBSCRIBE", productName: "零钱灵活", productId: products[0].id, riskLevel: "R1", accountMaskedNo: "•• 1234", amountMinor: 10000, feeMinor: 0, settlementMinor: 10000, navMicros: 1000000, quantityMicro: 100000000, businessDate: "2026-10-22", unlocksOn: "2026-10-22", requiredAuth: "MFA" },
  } }));
  await page.route("**/api/v1/investments/orders/INV-ui-fixture", route => { if (route.request().method() === "POST") commits++; return route.fulfill({ json: { status: "CANCELLED" } }); });
  await page.locator('[data-agent-id="wealth-product-SIM-1"]').click();
  await page.getByRole("button", { name: "申购", exact: true }).click();
  await page.getByLabel("申购金额（元）").fill("100");
  await page.getByRole("button", { name: "继续核对" }).click();
  const confirm = page.locator('[data-agent-id="wealth-confirm-order"]');
  await expect(confirm).toHaveAttribute("data-agent-permission", "human");
  await expect(confirm).toBeDisabled();
  await expect(page.getByLabel("理财验证器动态码")).toHaveAttribute("data-agent-private", "true");
  await expect(page.getByRole("dialog", { name: "核对申购" })).toContainText("红色操作");
  expect(commits).toBe(0);
});
