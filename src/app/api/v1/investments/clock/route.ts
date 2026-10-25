import { z } from "zod";
import { authenticateRequest } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/http";
import { advanceInvestmentClock } from "@/lib/investments";
import { investmentApiError } from "@/lib/investment-http";

const schema = z.object({ days: z.union([z.literal(1), z.literal(30), z.literal(90)]), expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), confirmed: z.literal(true) });
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    const input = schema.parse(await request.json());
    return Response.json(await advanceInvestmentClock(principal.customerId, input.days, input.expectedDate));
  } catch (error) { return investmentApiError(error); }
}
