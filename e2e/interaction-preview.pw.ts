import { test, expect, type Page } from "@playwright/test";

async function send(page: Page) {
  const input = page.getByRole("textbox", { name: "向悬浮助手描述需求或回答问题" });
  await input.fill("开始当前交互演示");
  await page.getByRole("button", { name: "发送给悬浮助手" }).click();
}

test("preview animates controlled React form fields and hands off final confirmation", async ({ page }) => {
  const bankRequests: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) bankRequests.push(request.url()); });
  await page.goto("/preview/agent");
  await page.getByRole("button", { name: "打开悬浮助手" }).click();
  await send(page);
  await page.getByRole("button", { name: "刘敏 · 尾号 1234" }).click();
  await page.getByRole("button", { name: "允许代操作", exact: true }).click();
  await expect(page.locator('[data-agent-overlay] [data-phase]')).toBeVisible();
  await expect(page.getByLabel("助手操作步骤")).toContainText("操作进度");
  await expect(page.getByRole("heading", { name: "核对转账信息" })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-agent-page]')).toContainText("周末聚餐 AA");
  const records = page.getByText("演示操作记录", { exact: false });
  await records.click();
  await expect(page.locator("details")).toContainText("填写金额 · APPLIED");
  await page.getByRole("button", { name: "确认演示 · 不转账" }).click();
  await expect(page.getByRole("heading", { name: "演示完成", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "继续代操作" }).click();
  await expect(page.getByRole("dialog", { name: "BankPilot 悬浮助手" })).toContainText("没有发生银行交易");
  expect(bankRequests).toEqual([]);
});

test("touching the input stops remaining characters; resume observes the user's edited value", async ({ page }) => {
  await page.goto("/preview/agent");
  await page.getByRole("button", { name: "申请虚拟卡", exact: true }).click();
  await send(page);
  await page.getByRole("button", { name: "允许代操作", exact: true }).click();
  const input = page.getByRole("textbox", { name: "卡片名称", exact: true });
  await expect.poll(() => input.inputValue(), { intervals: [15], timeout: 15000 }).toMatch(/^旅(?:行|行备)?$/);
  await input.fill("我自己的卡名");
  await expect(page.getByRole("button", { name: "打开悬浮助手" })).toContainText("已暂停");
  await page.waitForTimeout(300);
  await expect(input).toHaveValue("我自己的卡名");
  await expect(page.locator('[data-agent-overlay] [data-phase]')).toHaveCount(0);
  await expect(page.getByLabel("助手操作步骤")).toContainText("已暂停");
  await page.getByRole("button", { name: "继续代操作" }).click();
  await page.getByRole("button", { name: "保留当前：我自己的卡名" }).click();
  await expect(input).toHaveValue("我自己的卡名");
  await expect(page.getByRole("button", { name: "确认演示申请" })).toBeVisible();
});
