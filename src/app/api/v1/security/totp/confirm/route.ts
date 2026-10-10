import { z } from "zod";
import { AuthError, authenticateRequest, confirmTotpSetup } from "@/lib/auth";
import { apiError } from "@/lib/http";

const schema = z.object({ code: z.string().regex(/^\d{6}$/) });

export async function POST(request: Request) {
  try {
    if (request.headers.has("authorization")) throw new AuthError("MFA_SETUP_REQUIRES_BANK_APP", 403);
    if (request.headers.get("origin") !== new URL(process.env.BANKPILOT_PUBLIC_URL || request.url).origin) throw new AuthError("INVALID_ORIGIN", 403);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("MFA_SETUP_REQUIRES_BANK_APP", 403);
    return Response.json(await confirmTotpSetup(principal.customerId, schema.parse(await request.json()).code));
  } catch (error) {
    return apiError(error, "MFA_CONFIRM_FAILED");
  }
}
