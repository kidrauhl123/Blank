import { z } from "zod";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { commitTransfer } from "@/lib/bank-core";
import { apiError, assertSameOrigin } from "@/lib/http";

const schema = z.object({ totpCode: z.string().regex(/^\d{6}$/).optional(), taskId: z.string().uuid().optional() });

export async function POST(request: Request, context: RouteContext<"/api/v1/operations/[operationId]/authorize">) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("AUTHORIZATION_REQUIRES_BANK_APP", 403);
    const input = schema.parse(await request.json());
    const { operationId } = await context.params;
    const result = await commitTransfer(principal.customerId, operationId, input);
    if ("authError" in result) return Response.json({
      ...result,
      error: result.authError,
      message: result.authError === "AUTH_REQUIRED" ? "转账需要强验证，资金未转出。请核对红色操作并输入动态码再次确认。" : "强验证失败，资金未转出",
    }, { status: result.authError === "AUTH_REQUIRED" ? 409 : result.authError === "AUTH_FUSE_ACTIVE" ? 423 : 401 });
    return Response.json(result);
  } catch (error) {
    return apiError(error, "AUTHORIZATION_FAILED");
  }
}
