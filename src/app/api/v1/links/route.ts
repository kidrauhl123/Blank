import { authenticateRequest } from "@/lib/auth";
import { listBlankInbox, listBlankLinks } from "@/lib/blank-link-store";
import { apiError } from "@/lib/http";
import { noStore } from "@/lib/ui-http";

export const dynamic = "force-dynamic";

// 我的互联、我发出还没用的邀请、收件箱。互联是两个账户之间的事，所以用账户会话，不用访客 cookie。
export async function GET(request: Request) {
  try {
    const principal = await authenticateRequest(request);
    const [links, inbox] = await Promise.all([listBlankLinks(principal.customerId), listBlankInbox(principal.customerId)]);
    return Response.json({ ...links, inbox }, { headers: noStore });
  } catch (error) { return apiError(error, "BLANK_LINK_UNAVAILABLE"); }
}
