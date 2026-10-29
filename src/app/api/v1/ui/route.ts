import { apiError } from "@/lib/http";
import { getLayout } from "@/lib/ui-store";
import { noStore, uiPrincipal } from "@/lib/ui-http";

export const dynamic = "force-dynamic";

// 当前访客的首页排布、底部导航和自定义页面清单；没有自定义过就是默认布局。
export async function GET(request: Request) {
  try {
    const { customerId, ownerId } = await uiPrincipal(request);
    return Response.json(await getLayout(customerId, ownerId), { headers: noStore });
  } catch (error) { return apiError(error, "UI_UNAVAILABLE"); }
}
