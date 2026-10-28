import { AuthError, authenticateRequest } from "@/lib/auth";
import { listFeed } from "@/lib/feed-store";
import { apiError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
    return Response.json({ posts: await listFeed(principal.customerId) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error, "FEED_UNAVAILABLE");
  }
}
