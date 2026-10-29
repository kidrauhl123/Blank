import { z } from "zod";
import { apiError } from "@/lib/http";
import { getPageView } from "@/lib/ui-store";
import { noStore, uiPrincipal } from "@/lib/ui-http";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/ui/pages/[pageId]">) {
  try {
    const { customerId, ownerId } = await uiPrincipal(request);
    const { pageId } = await context.params;
    const view = ownerId && z.string().uuid().safeParse(pageId).success ? await getPageView(customerId, ownerId, pageId) : null;
    if (!view) return Response.json({ message: "页面不存在或已删除" }, { status: 404, headers: noStore });
    return Response.json({ page: view }, { headers: noStore });
  } catch (error) { return apiError(error, "UI_PAGE_UNAVAILABLE"); }
}
