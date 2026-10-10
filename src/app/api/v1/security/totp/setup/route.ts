import { z } from "zod";
import { AuthError, authenticateRequest, beginTotpSetup, verifyCustomerPassword } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { isDemoCustomer } from "@/lib/demo";

const schema = z.object({ password: z.string().min(1).max(128).optional(), demoConfirmed: z.boolean().optional() }).strict();

export async function POST(request: Request) {
  try {
    if (request.headers.has("authorization")) throw new AuthError("MFA_SETUP_REQUIRES_BANK_APP", 403);
    if (request.headers.get("origin") !== new URL(process.env.BANKPILOT_PUBLIC_URL || request.url).origin) throw new AuthError("INVALID_ORIGIN", 403);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("MFA_SETUP_REQUIRES_BANK_APP", 403);
    const input = schema.parse(await request.json());
    if (await isDemoCustomer(principal.customerId)) {
      if (input.demoConfirmed !== true) throw new AuthError("DEMO_MFA_CONFIRMATION_REQUIRED", 400);
    } else if (!input.password || !(await verifyCustomerPassword(principal.customerId, input.password))) throw new AuthError("INVALID_CREDENTIALS", 401);
    return Response.json(await beginTotpSetup(principal.customerId));
  } catch (error) {
    return apiError(error, "MFA_SETUP_FAILED");
  }
}
