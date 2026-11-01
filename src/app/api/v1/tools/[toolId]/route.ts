import { z } from "zod";
import { apiError, assertSameOrigin } from "@/lib/http";
import { getToolView, setToolSaved } from "@/lib/tool-store";
import { noStore, uiPrincipal } from "@/lib/ui-http";

export const dynamic = "force-dynamic";
const decision = z.object({ action: z.enum(["save", "unsave"]) }).strict();

// 对话里渲染小工具卡片：读到的是服务端按账本算好的基础数据，公式在前端算。
export async function GET(request: Request, context: RouteContext<"/api/v1/tools/[toolId]">) {
  try {
    const { customerId, ownerId } = await uiPrincipal(request);
    const { toolId } = await context.params;
    const tool = ownerId && z.string().uuid().safeParse(toolId).success ? await getToolView(customerId, ownerId, toolId) : null;
    if (!tool) return Response.json({ message: "小工具不存在" }, { status: 404, headers: noStore });
    return Response.json({ tool }, { headers: noStore });
  } catch (error) { return apiError(error, "TOOL_UNAVAILABLE"); }
}

// 用户在卡片上点“保存到首页”或“移出首页”。这是用户本人的点击，模型没有对应的工具。
export async function POST(request: Request, context: RouteContext<"/api/v1/tools/[toolId]">) {
  try {
    assertSameOrigin(request);
    const { customerId, ownerId } = await uiPrincipal(request);
    const { toolId } = await context.params;
    const input = decision.safeParse(await request.json().catch(() => null));
    if (!input.success || !ownerId || !z.string().uuid().safeParse(toolId).success) return Response.json({ message: "请求格式不正确" }, { status: 400, headers: noStore });
    try {
      await setToolSaved(customerId, ownerId, toolId, input.data.action === "save");
      return Response.json({ ok: true }, { headers: noStore });
    } catch (error) {
      if (error instanceof Error && error.message === "TOOL_NOT_FOUND") return Response.json({ message: "小工具不存在" }, { status: 404, headers: noStore });
      if (error instanceof Error && error.message === "HOME_FULL") return Response.json({ message: "首页已经放满了，先移出一个区块再保存。" }, { status: 409, headers: noStore });
      throw error;
    }
  } catch (error) { return apiError(error, "TOOL_UNAVAILABLE"); }
}
