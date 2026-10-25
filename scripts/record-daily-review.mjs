import { chromium } from "playwright";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Records the real application. This script never fulfills routes, writes model
// replies, changes system time, or chooses a Jev probability.
const base = new URL(process.env.BANKPILOT_RECORD_URL || "http://localhost:3109");
if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Use a plain application base URL");
const scenario = process.env.BANKPILOT_RECORD_SCENARIO || "birthday";
if (!["birthday", "quiet"].includes(scenario)) throw new Error("Scenario must be birthday or quiet");
const directory = path.resolve("output", "daily-review", new Date().toISOString().replaceAll(":", "-"));
await mkdir(directory, { recursive: true });
const preflight = await fetch(new URL("/api/health", base), { signal: AbortSignal.timeout(8000) });
const health = await preflight.json();
if (!preflight.ok || health.database !== "connected" || !health.ai?.configured) throw new Error("The application needs a connected database and configured main model before recording");

const browser = await chromium.launch({ headless: process.env.BANKPILOT_RECORD_HEADLESS !== "0", ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, recordVideo: { dir: directory, size: { width: 1280, height: 960 } }, reducedMotion: "reduce" });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const video = page.video();
const created = [];
const marks = [];
const cleanup = [];
const began = Date.now();
const mark = text => marks.push({ seconds: (Date.now() - began) / 1000, text });
const local = date => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date).replace(" ", "T");
let observed = null;
let success = false;
let failure = null;

async function submitTask() {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/schedules" && response.request().method() === "POST");
  await page.getByLabel("确认按以上时间执行，并使用所选通知方式").check();
  await page.getByRole("button", { name: "确认创建", exact: true }).click();
  const result = await response;
  if (!result.ok()) throw new Error(`Task creation failed (${result.status()})`);
  const task = (await result.json()).task;
  created.push(task.id);
  return task;
}

try {
  mark("进入真实模拟银行");
  await page.goto(base.href);
  await page.getByRole("button", { name: "以小橘子进入", exact: true }).click();
  await page.getByRole("button", { name: "AI 助手", exact: true }).waitFor();
  const overview = await (await context.request.get(new URL("/api/bootstrap", base).href)).json();
  if (!overview.features?.proactiveReviews) throw new Error("This deployment does not include the proactive home card");
  const ready = await (await context.request.get(new URL("/api/v1/schedules", base).href)).json();
  if (!ready.scheduler?.running || !ready.dailyReview?.jev.configured || !ready.dailyReview?.mainModel.configured) throw new Error("Scheduler, Jev and main model must all be ready");
  await page.getByRole("button", { name: "个人中心", exact: true }).click();
  await page.getByRole("link", { name: /定时任务/ }).click();
  await page.getByRole("heading", { name: "定时任务", exact: true }).waitFor();

  let birthday = null;
  if (scenario === "birthday") {
    mark("保存生日提醒和用户给定的礼物预算");
    await page.getByLabel("任务类型", { exact: true }).selectOption("REMINDER");
    await page.getByLabel("任务名称", { exact: true }).fill("录制：爱人生日准备");
    await page.getByLabel("提醒内容", { exact: true }).fill("爱人两天后过生日，鲜花预算 300 元，提前检查准备情况。本提醒未授权扣款或下单。");
    await page.getByLabel("首次执行时间", { exact: true }).fill(local(new Date(Date.now() + 2 * 86_400_000)));
    birthday = await submitTask();
    await page.getByRole("button", { name: "确认创建", exact: true }).waitFor();
    await delay(2500);
  }
  mark("开启每日巡检，本次使用近期真实时间等待后台自动触发");
  await page.getByLabel("任务类型", { exact: true }).selectOption("DAILY_AI_REVIEW");
  await page.getByLabel("任务名称", { exact: true }).fill(`录制：${scenario === "birthday" ? "生日准备巡检" : "日常账户巡检"}`);
  await page.getByLabel("关注事项（选填）", { exact: true }).fill(scenario === "birthday" ? "关注已保存的爱人生日准备提醒及 300 元鲜花预算；只需提供当前数据支持的关注事项。" : "没有新的关注事项时保持安静，不重复已经提示的记录。");
  await page.getByLabel("首次执行时间", { exact: true }).fill(local(new Date(Date.now() + 90_000)));
  const daily = await submitTask();
  await page.getByRole("link", { name: "← 返回银行", exact: true }).click();
  const card = page.getByRole("region", { name: "AI 主动关注" });
  await card.waitFor();
  mark("用户回到首页，等待独立 Worker 到时执行；没有发送 AI 消息或手动触发");

  const deadline = Date.now() + 180_000;
  let announcedStart = false;
  while (Date.now() < deadline) {
    const response = await context.request.get(new URL("/api/v1/schedules", base).href);
    if (!response.ok()) throw new Error(`Cannot read actual execution status (${response.status()})`);
    const state = await response.json();
    observed = state.runs.find(run => run.schedule_id === daily.id && run.ai) ?? null;
    if (observed && !announcedStart) {
      announcedStart = true; mark("后台已创建本轮检查，首页开始显示实际进度");
    }
    if (observed && ["SUCCEEDED", "SKIPPED", "FAILED", "CANCELLED"].includes(observed.status)) break;
    await delay(3000);
  }
  if (!observed || !["SUCCEEDED", "SKIPPED"].includes(observed.status)) throw new Error(`Review did not complete successfully: ${observed?.status ?? "no run"}`);
  if (observed.trigger_source !== "SCHEDULED") throw new Error("Expected a real scheduled trigger");
  const currentCard = page.locator(`[data-proactive-run-id="${observed.id}"]`);
  await currentCard.waitFor();
  await currentCard.getByRole("button", { name: "查看检查过程与结果", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "账户巡检", exact: true });
  await dialog.waitFor();
  await dialog.locator(`[data-review-run-id="${observed.id}"]`).waitFor();
  mark("展开实际 Jev 判断、主模型状态与结果");
  await delay(5000);
  await dialog.getByText("查看本次检查的数据依据", { exact: true }).click();
  mark("展示建议所依据的账户与提醒数据");
  await delay(5000);
  const birthdayHighlighted = birthday ? observed.ai.result?.factIds.some(id => id.startsWith(`reminder:${birthday.id}:`)) : null;
  success = scenario === "quiet" ? observed.status === "SKIPPED" : !!birthdayHighlighted;
  observed = { ...observed, birthdayHighlighted };
  if (!success) failure = "Recorded the real result, but it did not take the intended scenario branch. Do not label this take as a successful demonstration of that branch.";
} catch (error) {
  failure = error instanceof Error ? error.message : "Recording failed";
} finally {
  mark("本次录制结束");
  await page.close().catch(() => {});
  // Only remove future execution of the two tasks created by this recording.
  // Preserve their runs, audit trail and video evidence.
  for (const id of created) {
    try {
      const response = await context.request.patch(new URL("/api/v1/schedules", base).href, { headers: { origin: base.origin }, data: { id, action: "cancel" } });
      cleanup.push({ id, cancelled: response.ok(), httpStatus: response.status() });
    } catch { cleanup.push({ id, cancelled: false }); }
  }
  await context.close();
  const original = await video.path();
  const filename = success ? `${scenario}.webm` : `${scenario}.incomplete.webm`;
  await rename(original, path.join(directory, filename));
  await writeFile(path.join(directory, "recording.json"), JSON.stringify({ scenario, success, failure, marks, createdTaskIds: created, cleanup, run: observed }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ success, video: path.join(directory, success ? `${scenario}.webm` : `${scenario}.incomplete.webm`), evidence: path.join(directory, "recording.json"), failure }));
if (!success) process.exitCode = 1;
