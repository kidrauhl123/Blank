import { z } from "zod";
import { AuthError } from "@/lib/auth";
import { requireAppSession } from "@/lib/app-session";
import { getSessionModel } from "@/lib/model-settings";
import { actionResultSchema, pageSchema } from "@/lib/app-agent-protocol";
import { controlAppAgent, getAppAgentRun, startAppAgent } from "@/lib/app-agent-runtime";
import { appAgentFailure } from "@/lib/app-agent-errors";
import { withPreferenceScope } from "@/lib/preference-runtime";
import { resolveVisitorMemoryScope } from "@/lib/visitor-memory";

const schema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("start"), message: z.string().trim().min(1).max(1000), page: pageSchema, model: z.string().min(1).max(160).optional() }),
  z.object({ command: z.enum(["allow", "pause", "cancel"]), id: z.string().uuid() }),
  z.object({ command: z.enum(["advance", "refresh"]), id: z.string().uuid(), actionId: z.string().min(1).max(200), result: actionResultSchema }),
]);
function failure(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ message: "请求格式不正确" }, { status: 400 });
  if (error instanceof AuthError) {
    const preferenceMessages: Record<string, string> = {
      PREFERENCE_VERSION_CONFLICT: "偏好已在其他页面修改，请重新读取后再操作；本次未覆盖已有设置。",
      PREFERENCE_INVALID: "这项偏好内容不能保存；请检查称呼或改用设置页。",
    };
    return Response.json({ error: error.code, message: preferenceMessages[error.code] ?? "请在银行 APP 重新登录后操作" }, { status: error.status });
  }
  const { code, status, message, upstreamStatus } = appAgentFailure(error);
  console.error("APP_AGENT_REQUEST_FAILED", { code, upstreamStatus });
  return Response.json({ error: code, message }, { status });
}
export async function GET(request: Request) {
  try {
    const who = await requireAppSession(request);
    const scope = await resolveVisitorMemoryScope(request, who.customerId);
    return Response.json(await withPreferenceScope(scope, () => getAppAgentRun(who, z.string().uuid().parse(new URL(request.url).searchParams.get("id")))));
  }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const who = await requireAppSession(request);
    const scope = await resolveVisitorMemoryScope(request, who.customerId);
    const input = schema.parse(await request.json());
    return Response.json(await withPreferenceScope(scope, async () => {
      if (input.command === "start") return startAppAgent(who, input.message, input.page, input.model ?? await getSessionModel(who) ?? undefined);
      if (input.command === "advance" || input.command === "refresh") return controlAppAgent(who, input.id, input.command, input.actionId, input.result);
      return controlAppAgent(who, input.id, input.command);
    }));
  } catch (error) { return failure(error); }
}
