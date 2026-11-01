import { authenticateRequest } from "@/lib/auth";
import { acceptLinkInvite, type BlankLinkFailure } from "@/lib/blank-link-store";
import { apiError, assertSameOrigin } from "@/lib/http";
import { noStore } from "@/lib/ui-http";

export const dynamic = "force-dynamic";
const STATUS: Record<BlankLinkFailure["code"], number> = { INVALID: 400, NOT_FOUND: 404, DUPLICATE: 409, LIMIT: 429, FORBIDDEN: 403 };

// 接受邀请：只能在邀请提供的范围内选择内容。
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    const result = await acceptLinkInvite(principal.customerId, await request.json().catch(() => null));
    if (!result.ok) return Response.json({ message: result.error }, { status: STATUS[result.code], headers: noStore });
    return Response.json({ linkId: result.linkId, relation: result.relation, scopes: result.scopes }, { headers: noStore });
  } catch (error) { return apiError(error, "BLANK_LINK_ACCEPT_FAILED"); }
}
