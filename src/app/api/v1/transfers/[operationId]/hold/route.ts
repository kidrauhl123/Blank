import { z } from "zod";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { holdFraudTransfer } from "@/lib/fraud-store";
import { apiError, assertSameOrigin } from "@/lib/http";
import { noStore } from "@/lib/ui-http";

export const dynamic = "force-dynamic";
// 答案可以只答一部分，也可以不答；只接受拦截卡上的三个问题。
const body = z.object({
  answers: z.partialRecord(z.enum(["impostor", "secrecy", "safe-account"]), z.enum(["yes", "no"])).optional(),
}).strict();

// 用户在反诈拦截卡上选“24 小时后再办”。只能对被暂缓、还没过账的转账设置一次；到点后仍需要强验证。
export async function POST(request: Request, context: RouteContext<"/api/v1/transfers/[operationId]/hold">) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("AUTHORIZATION_REQUIRES_BANK_APP", 403);
    const { operationId } = await context.params;
    const input = body.safeParse(await request.json().catch(() => ({})));
    if (!input.success || !/^TRF-\d{8}-[0-9A-F]{8}$/.test(operationId)) return Response.json({ message: "请求格式不正确" }, { status: 400, headers: noStore });
    try {
      return Response.json(await holdFraudTransfer(principal.customerId, operationId, input.data.answers ?? {}), { headers: noStore });
    } catch (error) {
      if (error instanceof Error && error.message === "TRANSFER_NOT_HELD") return Response.json({ message: "这笔转账没有被反诈守护暂缓，或者已经设置过。" }, { status: 409, headers: noStore });
      throw error;
    }
  } catch (error) { return apiError(error, "TRANSFER_HOLD_FAILED"); }
}
