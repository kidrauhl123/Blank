import { NextResponse } from "next/server";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { getBankingOverview } from "@/lib/bank-core";
import { getAIStatus } from "@/lib/ai";
import { apiError } from "@/lib/http";
import { isDemoCustomer } from "@/lib/demo";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
    if (!(await isDemoCustomer(principal.customerId))) throw new AuthError("DEMO_PROFILE_REQUIRED");
    const overview = await getBankingOverview(principal.customerId);
    return NextResponse.json({ ...overview, customer: { ...overview.customer, demo: true }, ai: getAIStatus(), features: { proactiveReviews: true } });
  } catch (error) {
    return apiError(error, "BANK_CORE_UNAVAILABLE");
  }
}
