import { z } from "zod";
import { AuthError } from "@/lib/auth";
import { requireAppSession } from "@/lib/app-session";
import { getSessionModel } from "@/lib/model-settings";
import { actionResultSchema, pageSchema } from "@/lib/app-agent-protocol";
import { controlAppAgent, getAppAgentRun, startAppAgent } from "@/lib/app-agent-runtime";

const schema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("start"), message: z.string().trim().min(1).max(1000), page: pageSchema, model: z.string().min(1).max(160).optional() }),
  z.object({ command: z.enum(["allow", "pause", "cancel"]), id: z.string().uuid() }),
  z.object({ command: z.enum(["advance", "refresh"]), id: z.string().uuid(), actionId: z.string().min(1).max(200), result: actionResultSchema }),
]);
function failure(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ message: "请求格式不正确" }, { status: 400 });
  if (error instanceof AuthError) return Response.json({ error: error.code, message: "请在银行 APP 重新登录后操作" }, { status: error.status });
  const code = error instanceof Error ? error.message : "APP_AGENT_FAILED";
  const known: Record<string, [number, string]> = {
    APP_AGENT_NOT_FOUND: [404, "没有找到当前登录会话的助手任务"],
    APP_AGENT_EXPIRED: [410, "任务已过期，请重新发起"],
    APP_AGENT_BUSY: [409, "助手正在更新任务，请稍后继续"],
    APP_AGENT_STATE_CHANGED: [409, "任务状态已变化，请刷新后继续"],
    APP_AGENT_CONTROL_REQUIRED: [403, "尚未允许助手接管页面"],
    APP_AGENT_LIMIT: [422, "本次任务达到步骤上限，请接手操作"],
    APP_AGENT_RATE_LIMIT: [429, "发起任务过于频繁，请稍后再试"],
    AI_MODEL_NOT_AVAILABLE: [422, "该模型当前不可用，请到设置重新选择"],
    AI_MODEL_CATALOG_UNAVAILABLE: [503, "模型列表暂时不可用，请稍后重试"],
    AI_NOT_CONFIGURED: [503, "真实 AI 模型尚未配置，无法启动代操作"],
  };
  const [status, message] = known[code] ?? [502, "助手暂时不可用。请核对页面状态，可手动继续办理。"];
  return Response.json({ message }, { status });
}
export async function GET(request: Request) {
  try { return Response.json(await getAppAgentRun(await requireAppSession(request), z.string().uuid().parse(new URL(request.url).searchParams.get("id")))); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const who = await requireAppSession(request);
    const input = schema.parse(await request.json());
    if (input.command === "start") return Response.json(await startAppAgent(who, input.message, input.page, input.model ?? await getSessionModel(who) ?? undefined));
    if (input.command === "advance" || input.command === "refresh") return Response.json(await controlAppAgent(who, input.id, input.command, input.actionId, input.result));
    return Response.json(await controlAppAgent(who, input.id, input.command));
  } catch (error) { return failure(error); }
}
