import { z } from "zod";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { getRecipePreview } from "@/lib/feed-recipe-store";
import { apiError } from "@/lib/http";
import { resolveVisitorMemoryScope } from "@/lib/visitor-memory";

export const dynamic = "force-dynamic";

// 对话里渲染卡片预览：只能读取当前访客自己的配方，数字按现在的账本计算。
export async function GET(request: Request, context: RouteContext<"/api/v1/feed/recipes/[recipeId]">) {
  try {
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
    const { recipeId } = await context.params;
    const scope = await resolveVisitorMemoryScope(request, principal.customerId);
    const preview = scope && z.string().uuid().safeParse(recipeId).success ? await getRecipePreview(principal.customerId, scope.ownerId, recipeId) : null;
    if (!preview) return Response.json({ message: "卡片不存在或已删除" }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
    return Response.json(preview, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error, "RECIPE_UNAVAILABLE");
  }
}
