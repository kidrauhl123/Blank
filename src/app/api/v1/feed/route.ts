import { AuthError, authenticateRequest } from "@/lib/auth";
import { listFeed } from "@/lib/feed-store";
import { apiError } from "@/lib/http";
import { resolveVisitorMemoryScope } from "@/lib/visitor-memory";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
    // 配方帖子只给创建它的访客；没有访客身份时只看到系统帖子。
    const scope = await resolveVisitorMemoryScope(request, principal.customerId);
    return Response.json({ posts: await listFeed(principal.customerId, scope?.ownerId ?? null) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error, "FEED_UNAVAILABLE");
  }
}
