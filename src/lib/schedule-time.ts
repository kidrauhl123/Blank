import { z } from "zod";

export const scheduleInput = z.object({
  requestKey: z.string().uuid(),
  kind: z.enum(["REMINDER", "MONTHLY_REPORT", "SUBSCRIPTION_CHECK", "DAILY_AI_REVIEW"]),
  title: z.string().trim().min(1).max(80),
  message: z.string().trim().max(500).default(""),
  frequency: z.enum(["ONCE", "DAILY", "WEEKLY", "MONTHLY"]),
  timezone: z.literal("Asia/Shanghai").default("Asia/Shanghai"),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).nullable().default(null),
  channelIdentityId: z.string().uuid().nullable().default(null),
  confirmed: z.literal(true),
}).strict().superRefine((input, ctx) => {
  if (input.kind === "REMINDER" && !input.message) ctx.addIssue({ code: "custom", message: "请填写提醒内容" });
  if (input.kind === "MONTHLY_REPORT" && input.frequency !== "MONTHLY") ctx.addIssue({ code: "custom", message: "月度账单报告须按月执行" });
  if (input.kind === "DAILY_AI_REVIEW" && input.frequency !== "DAILY") ctx.addIssue({ code: "custom", message: "每日 AI 巡检须按天执行" });
  if (input.endsAt && new Date(input.endsAt) < new Date(input.startsAt)) ctx.addIssue({ code: "custom", message: "截止时间不能早于开始时间" });
});
export type ScheduleInput = z.infer<typeof scheduleInput>;
export type Frequency = ScheduleInput["frequency"];
const dayMs = 86_400_000;
const offsetMs = 8 * 3_600_000;

// Supported business timezone is explicitly limited to Shanghai (UTC+8).
// Monthly dates clamp to month-end while retaining the original day anchor.
export function nextOccurrence(start: Date, frequency: Frequency, after: Date): Date | null {
  if (start > after) return new Date(start);
  if (frequency === "ONCE") return null;
  if (frequency === "DAILY" || frequency === "WEEKLY") {
    const step = dayMs * (frequency === "WEEKLY" ? 7 : 1);
    return new Date(start.getTime() + (Math.floor((after.getTime() - start.getTime()) / step) + 1) * step);
  }
  const anchor = new Date(start.getTime() + offsetMs);
  const localAfter = new Date(after.getTime() + offsetMs);
  const months = Math.max(0, (localAfter.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + localAfter.getUTCMonth() - anchor.getUTCMonth());
  for (let index = months; index <= months + 1; index++) {
    const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + index, 1));
    const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const candidate = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(anchor.getUTCDate(), lastDay), anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()) - offsetMs);
    if (candidate > after) return candidate;
  }
  throw new Error("SCHEDULE_DATE_INVALID");
}

export function previousStatementMonth(scheduledFor: Date) {
  const local = new Date(scheduledFor.getTime() + offsetMs);
  const previous = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}
