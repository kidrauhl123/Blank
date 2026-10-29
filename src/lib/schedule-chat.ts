import { z } from "zod";
import { activateScheduledDraft, createScheduledTask, changeScheduledTask, getOwnedSchedule, listScheduledTasks, sampleScheduleResult, type ScheduledTask } from "./scheduled-tasks";

// 在对话里创建定时任务：Blank 先设计一份草稿并在对话里预览，用户同意后才生效。
// 时间用"北京时间的日期 + 钟点"描述，由服务端换算，模型不用算时区和 ISO 格式。
const KIND_LABEL = { REMINDER: "提醒", MONTHLY_REPORT: "月度账单报告", SUBSCRIPTION_CHECK: "订阅到期检查", DAILY_AI_REVIEW: "每日巡检" } as const;
const WEEKDAYS = "日一二三四五六";
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const scheduleDraftInput = z.object({
  kind: z.enum(["REMINDER", "MONTHLY_REPORT", "SUBSCRIPTION_CHECK", "DAILY_AI_REVIEW"])
    .describe("REMINDER 一条提醒；MONTHLY_REPORT 上个月的账单报告（固定每月）；SUBSCRIPTION_CHECK 检查未来 3 天的订阅扣费；DAILY_AI_REVIEW 每天巡检账户（固定每天，只在有变化时才发）"),
  title: z.string().trim().min(1).max(20).describe("任务名，例如“每月账单回顾”"),
  message: z.string().trim().max(200).default("").describe("REMINDER 的提醒内容（必填）；DAILY_AI_REVIEW 可写想重点关注的事；其余类型留空"),
  frequency: z.enum(["ONCE", "DAILY", "WEEKLY", "MONTHLY"]).describe("MONTHLY_REPORT 会按每月，DAILY_AI_REVIEW 会按每天"),
  firstDate: date.describe("第一次执行的日期，北京时间，YYYY-MM-DD，必须晚于现在。按系统给出的“当前时间”推算"),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:00").describe("几点执行，北京时间，HH:mm"),
  lastDate: date.optional().describe("最后一次执行的日期（选填），YYYY-MM-DD"),
});

export function describeRhythm(task: Pick<ScheduledTask, "frequency" | "starts_at" | "ends_at">) {
  const local = new Date(task.starts_at.getTime() + 8 * 3_600_000);
  const clock = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
  const when = task.frequency === "ONCE" ? `${local.getUTCMonth() + 1} 月 ${local.getUTCDate()} 日 ${clock} 执行一次`
    : task.frequency === "DAILY" ? `每天 ${clock}`
    : task.frequency === "WEEKLY" ? `每周${WEEKDAYS[local.getUTCDay()]} ${clock}`
    : `每月 ${local.getUTCDate()} 号 ${clock}`;
  return task.ends_at ? `${when}，到 ${new Date(task.ends_at.getTime() + 8 * 3_600_000).toISOString().slice(0, 10)} 为止` : when;
}
const stamp = (value: Date) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(value);

export type ScheduleCardView = {
  id: string; status: "DRAFT" | "ACTIVE" | "PAUSED" | "ERROR"; title: string; kind: string; rhythm: string; nextRun: string; message: string; sample: string; delivery: string;
};
export async function scheduleCard(customerId: string, task: ScheduledTask): Promise<ScheduleCardView> {
  return { id: task.id, status: task.status as ScheduleCardView["status"], title: task.title, kind: KIND_LABEL[task.kind], rhythm: describeRhythm(task),
    nextRun: stamp(task.status === "DRAFT" ? task.starts_at : task.next_run_at), message: task.message, sample: await sampleScheduleResult(customerId, task),
    delivery: "结果发到你的动态里，也可以在「定时任务」页查看" };
}

export async function previewSchedule(customerId: string, ownerId: string, raw: unknown) {
  const input = scheduleDraftInput.parse(raw);
  const frequency = input.kind === "MONTHLY_REPORT" ? "MONTHLY" : input.kind === "DAILY_AI_REVIEW" ? "DAILY" : input.frequency;
  const startsAt = new Date(`${input.firstDate}T${input.time}:00+08:00`);
  if (Number.isNaN(startsAt.getTime())) return { error: "日期格式不对，请用 YYYY-MM-DD" };
  if (startsAt.getTime() <= Date.now() + 60_000) return { error: `第一次执行时间必须晚于现在（现在是${stamp(new Date())}），请改成未来的日期或钟点。` };
  if (input.kind === "REMINDER" && !input.message) return { error: "提醒需要写明提醒内容。" };
  const endsAt = input.lastDate && frequency !== "ONCE" ? new Date(`${input.lastDate}T23:59:00+08:00`) : null;
  if (endsAt && endsAt <= startsAt) return { error: "最后一次执行的日期不能早于第一次。" };
  try {
    const task = await createScheduledTask(customerId, {
      requestKey: crypto.randomUUID(), kind: input.kind, title: input.title, message: input.message, frequency, timezone: "Asia/Shanghai",
      startsAt: startsAt.toISOString(), endsAt: endsAt?.toISOString() ?? null, channelIdentityId: null, confirmed: true,
    }, { ownerId, draft: true });
    return { scheduleId: task.id, marker: `[[schedule:${task.id}]]`, rhythm: describeRhythm(task), firstRun: stamp(task.starts_at) };
  } catch (error) {
    if (error instanceof Error && error.message === "SCHEDULE_LIMIT") return { error: "未结束的任务已经有 50 个，请先取消一些。" };
    throw error;
  }
}

export async function saveSchedule(customerId: string, ownerId: string, id?: string) {
  try {
    const task = await activateScheduledDraft(customerId, ownerId, id);
    return { saved: true, scheduleId: task.id, title: task.title, rhythm: describeRhythm(task), nextRun: stamp(task.next_run_at) };
  } catch (error) {
    const known: Record<string, string> = { SCHEDULE_NOT_FOUND: "没有找到待确认的任务草稿，可能已经保存过或已过期，请重新预览。", SCHEDULE_START_INVALID: "第一次执行的时间已经过了，请重新预览一个未来的时间。", SCHEDULE_LIMIT: "未结束的任务已经有 50 个，请先取消一些。" };
    if (error instanceof Error && known[error.message]) return { saved: false, error: known[error.message] };
    throw error;
  }
}

export async function listMySchedules(customerId: string, ownerId: string) {
  const { tasks } = await listScheduledTasks(customerId, ownerId);
  return tasks.filter(task => task.visitor_owner_id === ownerId && ["ACTIVE", "PAUSED", "ERROR"].includes(task.status))
    .map(task => ({ scheduleId: task.id, title: task.title, status: task.status, rhythm: describeRhythm(task), nextRun: stamp(task.next_run_at) }));
}

export async function changeMySchedule(customerId: string, ownerId: string, id: string, action: "pause" | "resume" | "cancel") {
  const task = await getOwnedSchedule(customerId, ownerId, id);
  if (!task || task.status === "DRAFT") return { changed: false, error: "没有找到这个任务。" };
  try {
    const updated = await changeScheduledTask(customerId, id, action, ownerId);
    return { changed: true, title: updated.title, status: updated.status };
  } catch (error) {
    if (error instanceof Error && ["SCHEDULE_NOT_FOUND", "SCHEDULE_NOT_ACTIVE"].includes(error.message)) return { changed: false, error: "这个任务已经结束或不存在。" };
    throw error;
  }
}
