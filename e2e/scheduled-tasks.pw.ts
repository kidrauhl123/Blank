import { test, expect } from "@playwright/test";

test("the schedules page lists tasks, has no manual creation form, and supports pause, resume and cancel", async ({ page }) => {
  const task = { id: "00000000-0000-4000-8000-000000000001", title: "每月账单回顾", status: "ACTIVE", frequency: "MONTHLY", next_run_at: "2027-01-01T01:00:00Z", retry_at: null };
  let posts = 0;
  await page.route("**/api/v1/schedules", async route => {
    if (route.request().method() === "POST") { posts++; await route.fulfill({ status: 405, json: {} }); }
    else if (route.request().method() === "PATCH") {
      const action = route.request().postDataJSON().action;
      task.status = action === "pause" ? "PAUSED" : action === "cancel" ? "CANCELLED" : "ACTIVE";
      await route.fulfill({ json: { task } });
    } else await route.fulfill({ json: { tasks: [task], runs: [], scheduler: { running: true, lastTickAt: new Date().toISOString() } } });
  });
  await page.goto("/schedules");
  // 创建只能在对话里完成：页面没有表单，只指引回去和 Blank 说。
  await expect(page.getByRole("button", { name: "确认创建" })).toHaveCount(0);
  await expect(page.getByLabel("任务名称")).toHaveCount(0);
  await expect(page.getByText("你说“好”才生效", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "去和 Blank 说" })).toHaveAttribute("href", "/");
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(page.getByText("执行中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消任务", exact: true }).click();
  await page.getByRole("button", { name: "确认取消", exact: true }).click();
  await expect(page.getByText("已取消", { exact: true })).toBeVisible();
  expect(posts).toBe(0);
});

test("offline scheduler, failure and notification state remain visible without mobile overflow", async ({ page }) => {
  await page.route("**/api/v1/schedules", route => route.fulfill({ json: {
    tasks: [{ id: "t", title: "周末检查", status: "ERROR", frequency: "WEEKLY", next_run_at: "2026-10-17T01:00:00Z" }],
    runs: [{ id: "r", title: "周末检查", status: "FAILED", summary: "连续三次执行失败，任务已停止。可核对后恢复。", completed_at: "2026-10-17T01:00:00Z", delivery: null }],
    scheduler: { running: false, lastTickAt: null },
  } }));
  await page.goto("/schedules");
  await expect(page.getByText(/后台调度暂未就绪/)).toBeVisible();
  await expect(page.getByText("需处理", { exact: true })).toBeVisible();
  await expect(page.getByText("连续三次执行失败，任务已停止。可核对后恢复。")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
