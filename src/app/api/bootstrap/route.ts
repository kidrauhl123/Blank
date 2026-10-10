import { NextResponse } from "next/server";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { getBankingOverview } from "@/lib/bank-core";
import { getAIStatus } from "@/lib/ai";
import { apiError } from "@/lib/http";
import { demoEnabled, isDemoCustomer } from "@/lib/demo";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
    if (demoEnabled() && !(await isDemoCustomer(principal.customerId))) throw new AuthError("DEMO_PROFILE_REQUIRED");
    return NextResponse.json({ ...(await getBankingOverview(principal.customerId)), ai: getAIStatus(), demoMode: demoEnabled() });
  } catch (error) {
    return apiError(error, "BANK_CORE_UNAVAILABLE");
  }
}
