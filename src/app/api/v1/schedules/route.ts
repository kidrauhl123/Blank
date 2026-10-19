import { z } from "zod";
import { authenticateRequest } from "@/lib/auth";
import { assertSameOrigin, apiError } from "@/lib/http";
import { createScheduledTask, changeScheduledTask, listScheduledTasks } from "@/lib/scheduled-tasks";

const change = z.object({ id: z.string().uuid(), action: z.enum(["pause", "resume", "cancel"]) }).strict();
function failure(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: "SCHEDULE_INPUT_INVALID", message: "请检查任务内容、时间和确认选项。" }, { status: 400 });
  const messages: Record<string, [number, string]> = {
    SCHEDULE_START_INVALID: [400, "首次执行时间必须在未来，且不晚于 2099 年。"],
    SCHEDULE_LIMIT: [409, "最多保留 50 个未结束任务，请先取消不需要的任务。"],
    SCHEDULE_NOT_FOUND: [404, "未找到此任务。"],
    SCHEDULE_NOT_ACTIVE: [409, "任务已结束，请刷新后查看。"],
  };
  const known = error instanceof Error ? messages[error.message] : undefined;
  if (known) return Response.json({ message: known[1] }, { status: known[0] });
  return apiError(error, "SCHEDULE_UNAVAILABLE");
}
export async function GET(request: Request) {
  try {
    const principal = await authenticateRequest(request);
    return Response.json(await listScheduledTasks(principal.customerId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    return Response.json({ task: await createScheduledTask(principal.customerId, await request.json()) });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    const input = change.parse(await request.json());
    return Response.json({ task: await changeScheduledTask(principal.customerId, input.id, input.action) });
  } catch (error) { return failure(error); }
}
