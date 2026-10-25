import { z } from "zod";
import { requireAppSession } from "@/lib/app-session";
import { apiError } from "@/lib/http";
import { requestManualDailyReview } from "@/lib/manual-daily-review";

export async function POST(request: Request) {
  try {
    const session = await requireAppSession(request);
    return Response.json(await requestManualDailyReview(session.customerId, await request.json()));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ message: "请重新选择巡检任务。" }, { status: 400 });
    const messages: Record<string, [number, string]> = {
      SCHEDULE_NOT_FOUND: [404, "未找到巡检任务。"],
      REVIEW_TASK_NOT_ACTIVE: [409, "请先启用一个有效的每日 AI 巡检任务。"],
      REVIEW_NOT_CONFIGURED: [503, "分析服务尚未配置完成，暂时无法开始检查。"],
      REVIEW_ALREADY_RUNNING: [409, "已有检查正在执行，请等待下方结果。"],
      REVIEW_REQUEST_MISMATCH: [409, "请求与原巡检任务不一致，请刷新后重试。"],
      REVIEW_DAILY_LIMIT: [429, "24 小时内最多手动检查 12 次，自动巡检不受影响。"],
    };
    const known = error instanceof Error ? messages[error.message] : undefined;
    if (known) return Response.json({ error: error instanceof Error ? error.message : undefined, message: known[1] }, { status: known[0] });
    return apiError(error, "REVIEW_UNAVAILABLE");
  }
}
