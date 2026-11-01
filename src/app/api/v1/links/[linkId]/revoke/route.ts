import { z } from "zod";
import { authenticateRequest } from "@/lib/auth";
import { revokeBlankLink, type BlankLinkFailure } from "@/lib/blank-link-store";
import { apiError, assertSameOrigin } from "@/lib/http";
import { noStore } from "@/lib/ui-http";

export const dynamic = "force-dynamic";
const STATUS: Record<BlankLinkFailure["code"], number> = { INVALID: 400, NOT_FOUND: 404, DUPLICATE: 409, LIMIT: 429, FORBIDDEN: 403 };

// 撤销互联：双方都可以随时撤销，撤销后不能再发，也看不到对方的新消息。
export async function POST(request: Request, context: RouteContext<"/api/v1/links/[linkId]/revoke">) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    const { linkId } = await context.params;
    if (!z.string().uuid().safeParse(linkId).success) return Response.json({ message: "没有找到这条互联。" }, { status: 404, headers: noStore });
    const result = await revokeBlankLink(principal.customerId, linkId);
    if (!result.ok) return Response.json({ message: result.error }, { status: STATUS[result.code], headers: noStore });
    return Response.json({ ok: true }, { headers: noStore });
  } catch (error) { return apiError(error, "BLANK_LINK_REVOKE_FAILED"); }
}
