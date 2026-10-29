import { z } from "zod";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { getOwnedSchedule } from "@/lib/scheduled-tasks";
import { scheduleCard } from "@/lib/schedule-chat";
import { resolveVisitorMemoryScope } from "@/lib/visitor-memory";

export const dynamic = "force-dynamic";

// 对话里渲染任务预览：只能读取当前访客自己创建的任务。
export async function GET(request: Request, context: RouteContext<"/api/v1/schedules/drafts/[scheduleId]">) {
  try {
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
    const { scheduleId } = await context.params;
    const scope = await resolveVisitorMemoryScope(request, principal.customerId);
    const task = scope && z.string().uuid().safeParse(scheduleId).success ? await getOwnedSchedule(principal.customerId, scope.ownerId, scheduleId) : null;
    if (!task) return Response.json({ message: "任务不存在或已结束" }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
    return Response.json({ card: await scheduleCard(principal.customerId, task) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error, "SCHEDULE_UNAVAILABLE");
  }
}
