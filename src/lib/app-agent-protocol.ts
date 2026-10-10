import { z } from "zod";

export const controlSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().max(180),
  kind: z.enum(["button", "input", "select"]),
  permission: z.enum(["navigate", "fill", "prepare", "human"]),
  value: z.string().max(200).optional(),
  options: z.array(z.string().max(100)).max(30).optional(),
  disabled: z.boolean(),
});
export const pageSchema = z.object({
  name: z.string().max(120),
  version: z.string().max(40),
  text: z.string().max(8000),
  controls: z.array(controlSchema).max(100),
});
export type AppPage = z.infer<typeof pageSchema>;
export const pageActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inspect"), description: z.string().max(200) }),
  z.object({ type: z.literal("click"), target: z.string().max(120), pageVersion: z.string().max(40), description: z.string().max(200) }),
  z.object({ type: z.literal("fill"), target: z.string().max(120), value: z.string().max(200), pageVersion: z.string().max(40), description: z.string().max(200) }),
  z.object({ type: z.literal("scroll"), direction: z.enum(["up", "down"]), pageVersion: z.string().max(40), description: z.string().max(200) }),
  z.object({ type: z.literal("question"), question: z.string().min(1).max(300), options: z.array(z.string().min(1).max(100)).min(2).max(4) }),
  z.object({ type: z.literal("handoff"), description: z.string().min(1).max(300) }),
]);
export type PageAction = z.infer<typeof pageActionSchema>;
export type PendingAction = { id: string; action: PageAction };
export const actionResultSchema = z.object({
  status: z.enum(["OBSERVED", "APPLIED", "BLOCKED", "USER_CHANGED", "USER_ANSWERED"]),
  message: z.string().max(500),
  page: pageSchema,
});
export type ActionResult = z.infer<typeof actionResultSchema>;
export type AppAgentStatus = "RUNNING" | "CONSENT" | "ACTION" | "QUESTION" | "HANDOFF" | "PAUSED" | "COMPLETED" | "CANCELLED" | "FAILED";
export type AppAgentView = {
  id: string;
  status: AppAgentStatus;
  message: string;
  pending: PendingAction | null;
  controlGranted: boolean;
  steps: number;
};

// Page tools deliberately cannot approve a bank operation, read OTPs or execute JS.
export function canApplyAction(action: PageAction, page: AppPage): string | null {
  if (action.type === "question" || action.type === "handoff") return "USER_REQUIRED";
  if (action.type === "inspect") return null;
  if (action.pageVersion !== page.version) return "PAGE_CHANGED";
  if (action.type === "scroll") return null;
  const target = page.controls.find((control) => control.id === action.target);
  if (!target || target.disabled) return "TARGET_UNAVAILABLE";
  if (target.permission === "human") return "USER_REQUIRED";
  if (action.type === "click" && target.kind !== "button") return "ACTION_NOT_ALLOWED";
  if (action.type === "fill" && (target.permission !== "fill" || target.kind === "button")) return "ACTION_NOT_ALLOWED";
  if (action.type === "fill" && target.options && !target.options.includes(action.value)) return "INVALID_OPTION";
  return null;
}
