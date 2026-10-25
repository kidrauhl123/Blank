import { z } from "zod";
import { authenticateRequest } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/http";
import { cancelInvestment, commitInvestment, getInvestmentOrder } from "@/lib/investments";
import { investmentApiError } from "@/lib/investment-http";

const schema = z.object({ confirmed: z.literal(true), totpCode: z.string().regex(/^\d{6}$/).optional() });
type Context = { params: Promise<{ operationId: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const principal = await authenticateRequest(request);
    return Response.json(await getInvestmentOrder(principal.customerId, (await context.params).operationId));
  } catch (error) { return investmentApiError(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    const input = schema.parse(await request.json());
    const result = await commitInvestment(principal.customerId, (await context.params).operationId, input.totpCode);
    if ("authError" in result) return Response.json({ error: result.authError,
      message: result.authError === "AUTH_REQUIRED" ? "请启用验证器并输入动态码，资金尚未变动。"
        : result.authError === "AUTH_FUSE_ACTIVE" ? "连续验证失败，请等待 15 分钟后重试，资金尚未变动。" : "动态码无效或已使用，资金尚未变动。" },
    { status: result.authError === "AUTH_FUSE_ACTIVE" ? 423 : 401 });
    return Response.json(result);
  } catch (error) { return investmentApiError(error); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    return Response.json(await cancelInvestment(principal.customerId, (await context.params).operationId));
  } catch (error) { return investmentApiError(error); }
}
