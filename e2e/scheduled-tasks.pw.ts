import { test, expect } from "@playwright/test";

test("schedule creation requires explicit confirmation and supports pause and cancel", async ({ page }) => {
  const task = { id: "00000000-0000-4000-8000-000000000001", title: "每月账单回顾", status: "ACTIVE", frequency: "MONTHLY", next_run_at: "2027-01-01T01:00:00Z", retry_at: null };
  let created = false;
  let posted: Record<string, unknown> | undefined;
  await page.route("**/api/v1/channels", route => route.fulfill({ json: { channels: [] } }));
  await page.route("**/api/v1/schedules", async route => {
    if (route.request().method() === "POST") {
      posted = route.request().postDataJSON(); created = true;
      await route.fulfill({ json: { task } });
    } else if (route.request().method() === "PATCH") {
      const action = route.request().postDataJSON().action;
      task.status = action === "pause" ? "PAUSED" : action === "cancel" ? "CANCELLED" : "ACTIVE";
      await route.fulfill({ json: { task } });
    } else await route.fulfill({ json: { tasks: created ? [task] : [], runs: [], scheduler: { running: true, lastTickAt: new Date().toISOString() } } });
  });
  await page.goto("/schedules");
  await page.getByLabel("任务类型").selectOption("MONTHLY_REPORT");
  await expect(page.getByLabel("执行频率")).toHaveValue("MONTHLY");
  await expect(page.getByLabel("执行频率")).toBeDisabled();
  await page.getByLabel("任务名称").fill("每月账单回顾");
  await page.getByLabel("首次执行时间").fill("2027-01-01T09:00");
  await page.getByRole("button", { name: "确认创建" }).click();
  expect(created).toBe(false);
  await page.getByLabel("确认按以上时间执行，并使用所选通知方式").check();
  await page.getByRole("button", { name: "确认创建" }).click();
  await expect(page.getByText("任务已保存，可在下方查看下次执行时间。")).toBeVisible();
  expect(posted).toMatchObject({ kind: "MONTHLY_REPORT", frequency: "MONTHLY", startsAt: "2027-01-01T01:00:00.000Z", timezone: "Asia/Shanghai", confirmed: true, channelIdentityId: null });
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(page.getByText("执行中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消任务", exact: true }).click();
  await page.getByRole("button", { name: "确认取消", exact: true }).click();
  await expect(page.getByText("已取消", { exact: true })).toBeVisible();
});

test("offline scheduler, failure and notification state remain visible without mobile overflow", async ({ page }) => {
  await page.route("**/api/v1/channels", route => route.fulfill({ json: { channels: [] } }));
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

test("ambiguous create retries the original payload without duplicating the task", async ({ page }) => {
  let first: unknown;
  let requests = 0;
  await page.route("**/api/v1/channels", route => route.fulfill({ json: { channels: [] } }));
  await page.route("**/api/v1/schedules", async route => {
    if (route.request().method() === "POST") {
      requests++;
      const body = route.request().postDataJSON();
      if (requests === 1) { first = body; await route.abort(); }
      else { expect(body).toEqual(first); await route.fulfill({ json: { task: { id: "t" } } }); }
    } else await route.fulfill({ json: { tasks: [], runs: [], scheduler: { running: true, lastTickAt: null } } });
  });
  await page.goto("/schedules");
  await page.getByLabel("任务名称").fill("周末提醒");
  await page.getByLabel("提醒内容").fill("核对账单");
  await page.getByLabel("首次执行时间").fill("2027-01-01T09:00");
  await page.getByLabel("确认按以上时间执行，并使用所选通知方式").check();
  await page.getByRole("button", { name: "确认创建" }).click();
  await expect(page.getByLabel("任务名称")).toBeDisabled();
  await page.getByRole("button", { name: "重试原请求并核对结果" }).click();
  await expect(page.getByText("任务已保存，可在下方查看下次执行时间。")).toBeVisible();
  expect(requests).toBe(2);
});
