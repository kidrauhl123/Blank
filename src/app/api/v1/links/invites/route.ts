import { authenticateRequest } from "@/lib/auth";
import { createLinkInvite, type BlankLinkFailure } from "@/lib/blank-link-store";
import { apiError, assertSameOrigin } from "@/lib/http";
import { noStore } from "@/lib/ui-http";

export const dynamic = "force-dynamic";
const STATUS: Record<BlankLinkFailure["code"], number> = { INVALID: 400, NOT_FOUND: 404, DUPLICATE: 409, LIMIT: 429, FORBIDDEN: 403 };

// 创建邀请：邀请码只在这次响应里出现一次，之后只能看到邀请的关系和范围。
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    const result = await createLinkInvite(principal.customerId, await request.json().catch(() => null));
    if (!result.ok) return Response.json({ message: result.error }, { status: STATUS[result.code], headers: noStore });
    return Response.json({ code: result.code, expiresAt: result.expiresAt }, { headers: noStore });
  } catch (error) { return apiError(error, "BLANK_LINK_INVITE_FAILED"); }
}
