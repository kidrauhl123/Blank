import { z } from "zod";
import { setFeedReaction } from "@/lib/feed-store";
import { apiError, assertSameOrigin } from "@/lib/http";
import { noStore, uiPrincipal } from "@/lib/ui-http";

export const dynamic = "force-dynamic";
const input = z.object({ postId: z.string().uuid(), reaction: z.enum(["up", "down", "clear"]) }).strict();

// 用户对一条动态点赞或点踩（再点一次取消）。口味记到服务端，之后判断候选动态时会带上。
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { customerId, ownerId } = await uiPrincipal(request);
    const parsed = input.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ message: "请求格式不正确" }, { status: 400, headers: noStore });
    const found = await setFeedReaction(customerId, ownerId ?? "customer", parsed.data.postId, parsed.data.reaction === "clear" ? null : parsed.data.reaction);
    if (!found) return Response.json({ message: "没有找到这条动态。" }, { status: 404, headers: noStore });
    return Response.json({ ok: true }, { headers: noStore });
  } catch (error) { return apiError(error, "FEED_REACTION_FAILED"); }
}
