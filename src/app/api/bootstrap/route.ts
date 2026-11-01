import { NextResponse } from "next/server";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { getBankingOverview } from "@/lib/bank-core";
import { getAIStatus } from "@/lib/ai";
import { apiError } from "@/lib/http";
import { isDemoCustomer } from "@/lib/demo";
import { resolveVisitorMemoryScope } from "@/lib/visitor-memory";
import { withVisitorModel } from "@/lib/visitor-model-key";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
    if (!(await isDemoCustomer(principal.customerId))) throw new AuthError("DEMO_PROFILE_REQUIRED");
    const overview = await getBankingOverview(principal.customerId);
    // 模型状态按这位访客的配置显示：他自己填写了接口就显示已配置，不管运营方有没有配置。
    const scope = await resolveVisitorMemoryScope(request, principal.customerId);
    const ai = await withVisitorModel(scope, async () => getAIStatus());
    return NextResponse.json({ ...overview, customer: { ...overview.customer, demo: true }, ai, features: { voiceCalls: process.env.VOICE_ENABLED === "true" && Boolean(process.env.VOICE_BRIDGE_TOKEN?.trim()) } });
  } catch (error) {
    return apiError(error, "BANK_CORE_UNAVAILABLE");
  }
}
