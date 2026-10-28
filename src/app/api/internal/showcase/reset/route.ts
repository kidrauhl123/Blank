import { resetShowcaseLife } from "@/lib/demo-life";
import { apiError } from "@/lib/http";
import { assertSchedulerRequest } from "@/lib/scheduler-auth";

export const runtime = "nodejs";
// 运维用：撤销展示账户的生活模拟，调度器下一轮会从头回放。只接受调度器专用凭据。
export async function POST(request: Request) {
  try {
    assertSchedulerRequest(request);
    return Response.json({ reset: await resetShowcaseLife() });
  } catch (error) { return apiError(error, "SHOWCASE_RESET_FAILED"); }
}
