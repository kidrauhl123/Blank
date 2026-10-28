import { z } from "zod";
import { AuthError } from "@/lib/auth";
import { requireAppSession } from "@/lib/app-session";
import { getSessionModel } from "@/lib/model-settings";
import { actionResultSchema, pageSchema } from "@/lib/app-agent-protocol";
import { controlAppAgent, getAppAgentRun, startAppAgent } from "@/lib/app-agent-runtime";
import { appAgentFailure } from "@/lib/app-agent-errors";
import { withPreferenceScope } from "@/lib/preference-runtime";
import { resolveVisitorMemoryScope } from "@/lib/visitor-memory";

import { withAppAgentStream } from "@/lib/app-agent-stream";
import type { AppAgentStreamEvent } from "@/lib/app-agent-stream-protocol";

export const runtime = "nodejs";

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
      PREFERENCE_INVALID: "这项偏好内容不能保存，请换一个明确的称呼或偏好表达。",
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
    return Response.json(await withPreferenceScope(scope, () => getAppAgentRun(who, z.string().uuid().parse(new URL(request.url).searchParams.get("id")))), { headers: { "Cache-Control": "private, no-store" } });
  }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const who = await requireAppSession(request);
    const scope = await resolveVisitorMemoryScope(request, who.customerId);
    const input = schema.parse(await request.json());
    const execute = () => withPreferenceScope(scope, async () => {
      if (input.command === "start") return startAppAgent(who, input.message, input.page, input.model ?? await getSessionModel(who) ?? undefined);
      if (input.command === "advance" || input.command === "refresh") return controlAppAgent(who, input.id, input.command, input.actionId, input.result);
      return controlAppAgent(who, input.id, input.command);
    });
    if (!request.headers.get("accept")?.includes("text/event-stream")) return Response.json(await execute());
    const abort = new AbortController();
    const signal = AbortSignal.any([request.signal, abort.signal]);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const emit = (event: AppAgentStreamEvent) => {
          if (closed || signal.aborted) return;
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); }
          catch { closed = true; abort.abort(); }
        };
        const heartbeat = setInterval(() => {
          if (closed || signal.aborted) return;
          try { controller.enqueue(encoder.encode(": keepalive\n\n")); }
          catch { closed = true; abort.abort(); }
        }, 15000);
        void withAppAgentStream({ emit, signal }, execute).then(run => emit({ type: "result", run })).catch(async error => {
          if (!signal.aborted) {
            const response = failure(error);
            const result = await response.json();
            emit({ type: "error", message: result.message });
          }
        }).finally(() => {
          clearInterval(heartbeat);
          if (!closed) { closed = true; try { controller.close(); } catch { /* Client disconnected. */ } }
        });
      },
      cancel() { abort.abort(); },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-store, no-transform", "X-Accel-Buffering": "no" } });
  } catch (error) { return failure(error); }
}
