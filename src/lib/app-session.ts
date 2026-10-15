import { createHash } from "node:crypto";
import { authenticateRequest, AuthError, getSessionToken, SESSION_COOKIE } from "./auth";
import { assertSameOrigin } from "./http";

export async function requireAppSession(request: Request) {
  assertSameOrigin(request);
  const principal = await authenticateRequest(request);
  const token = getSessionToken(request);
  if (!token) throw new AuthError("AUTHENTICATION_REQUIRED");
  return {
    customerId: principal.customerId,
    sessionHash: createHash("sha256").update(`${SESSION_COOKIE}=${token}`).digest("hex"),
    sessionTokenHash: createHash("sha256").update(token).digest("hex"),
  };
}
