import { authenticateRequest } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/http";
import { investmentAssessmentSchema, saveInvestmentAssessment } from "@/lib/investments";
import { investmentApiError } from "@/lib/investment-http";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    return Response.json(await saveInvestmentAssessment(principal.customerId, investmentAssessmentSchema.parse(await request.json())));
  } catch (error) { return investmentApiError(error); }
}
