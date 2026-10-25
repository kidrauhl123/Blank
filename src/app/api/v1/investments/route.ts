import { authenticateRequest } from "@/lib/auth";
import { getInvestmentOverview } from "@/lib/investments";
import { investmentApiError } from "@/lib/investment-http";

export async function GET(request: Request) {
  try {
    const principal = await authenticateRequest(request);
    return Response.json(await getInvestmentOverview(principal.customerId));
  } catch (error) { return investmentApiError(error); }
}
