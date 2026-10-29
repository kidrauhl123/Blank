import { z } from "zod";
import { apiError, assertSameOrigin } from "@/lib/http";
import { decideProposal, getProposalView } from "@/lib/ui-store";
import { noStore, uiPrincipal } from "@/lib/ui-http";

export const dynamic = "force-dynamic";
const decision = z.object({ action: z.enum(["apply", "dismiss"]) }).strict();

// 对话里渲染界面变更提案的预览。
export async function GET(request: Request, context: RouteContext<"/api/v1/ui/proposals/[proposalId]">) {
  try {
    const { customerId, ownerId } = await uiPrincipal(request);
    const { proposalId } = await context.params;
    const view = ownerId && z.string().uuid().safeParse(proposalId).success ? await getProposalView(customerId, ownerId, proposalId) : null;
    if (!view) return Response.json({ message: "方案不存在" }, { status: 404, headers: noStore });
    return Response.json({ proposal: view }, { headers: noStore });
  } catch (error) { return apiError(error, "UI_PROPOSAL_UNAVAILABLE"); }
}

// 用户点“应用”或“不要”。界面结构只会在这里改变：这是用户本人在 APP 里的点击，模型没有对应的工具。
export async function POST(request: Request, context: RouteContext<"/api/v1/ui/proposals/[proposalId]">) {
  try {
    assertSameOrigin(request);
    const { customerId, ownerId } = await uiPrincipal(request);
    const { proposalId } = await context.params;
    const input = decision.safeParse(await request.json().catch(() => null));
    if (!input.success || !ownerId || !z.string().uuid().safeParse(proposalId).success) return Response.json({ message: "请求格式不正确" }, { status: 400, headers: noStore });
    try { return Response.json(await decideProposal(customerId, ownerId, proposalId, input.data.action), { headers: noStore }); }
    catch (error) {
      if (error instanceof Error && error.message === "PROPOSAL_NOT_FOUND") return Response.json({ message: "方案不存在" }, { status: 404, headers: noStore });
      if (error instanceof Error && error.message === "PROPOSAL_STALE") return Response.json({ message: "页面已经变化，这个方案不能再应用，请让 Blank 重新设计。" }, { status: 409, headers: noStore });
      throw error;
    }
  } catch (error) { return apiError(error, "UI_PROPOSAL_FAILED"); }
}
