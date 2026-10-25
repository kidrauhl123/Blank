import type { JevGate } from "./jev";
import type { DailyReviewSnapshot } from "./daily-review-policy";

export type ScheduleTaskView = { id: string; kind: string; title: string; status: string; frequency: string; next_run_at: string; retry_at: string | null; channel_identity_id: string | null };
export type ScheduleRunView = { id: string; schedule_id: string; title: string; status: string; summary: string; completed_at: string; trigger_source: "SCHEDULED" | "MANUAL";
  delivery: { status: string; attempts: number } | null;
  ai?: { status: string; gate: JevGate | null; mainRequestedAt: string | null; capturedAt: string | null; facts: DailyReviewSnapshot["facts"] | null;
    result: { mainModel: string | null; capturedAt: string; factIds: string[] } | null; error: string | null } | null };
export type ScheduleData = { tasks: ScheduleTaskView[]; runs: ScheduleRunView[]; scheduler: { running: boolean; lastTickAt: string | null };
  dailyReview?: { jev: { configured: boolean; model: string }; mainModel: { configured: boolean; model: string | null } } };
