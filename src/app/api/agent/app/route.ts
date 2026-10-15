import { z } from "zod";
import { AuthError } from "@/lib/auth";
import { requireAppSession } from "@/lib/app-session";
import { getSessionModel } from "@/lib/model-settings";
import { actionResultSchema, pageSchema } from "@/lib/app-agent-protocol";
import { controlAppAgent, getAppAgentRun, startAppAgent } from "@/lib/app-agent-runtime";
import { appAgentFailure } from "@/lib/app-agent-errors";

const schema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("start"), message: z.string().trim().min(1).max(1000), page: pageSchema, model: z.string().min(1).max(160).optional() }),
  z.object({ command: z.enum(["allow", "pause", "cancel"]), id: z.string().uuid() }),
  z.object({ command: z.enum(["advance", "refresh"]), id: z.string().uuid(), actionId: z.string().min(1).max(200), result: actionResultSchema }),
]);
function failure(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ message: "请求格式不正确" }, { status: 400 });
  if (error instanceof AuthError) return Response.json({ error: error.code, message: "请在银行 APP 重新登录后操作" }, { status: error.status });
  const { code, status, message, upstreamStatus } = appAgentFailure(error);
  console.error("APP_AGENT_REQUEST_FAILED", { code, upstreamStatus });
  return Response.json({ error: code, message }, { status });
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
