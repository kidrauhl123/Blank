import { authenticateRequest } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/http";
import { investmentPrepareSchema, prepareInvestment } from "@/lib/investments";
import { investmentApiError } from "@/lib/investment-http";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    return Response.json(await prepareInvestment(principal.customerId, investmentPrepareSchema.parse(await request.json())), { status: 201 });
  } catch (error) { return investmentApiError(error); }
}
