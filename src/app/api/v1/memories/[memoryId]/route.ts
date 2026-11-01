import { z } from "zod";
import { apiError, assertSameOrigin } from "@/lib/http";
import { deleteLifeMemory, updateLifeMemory } from "@/lib/life-memory";
import { noStore, uiPrincipal } from "@/lib/ui-http";

export const dynamic = "force-dynamic";
const version = z.string().regex(/^\d{1,19}$/);
const edit = z.object({
  version,
  text: z.string().trim().min(1).max(60).optional(),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
}).strict();
const remove = z.object({ version }).strict();

// 用户在界面上修改一条记忆（自己的输入，不需要出现在对话里）。
export async function PATCH(request: Request, context: RouteContext<"/api/v1/memories/[memoryId]">) {
  try {
    assertSameOrigin(request);
    const { customerId, ownerId } = await uiPrincipal(request);
    const { memoryId } = await context.params;
    const input = edit.safeParse(await request.json().catch(() => null));
    if (!input.success || !ownerId || !z.string().uuid().safeParse(memoryId).success) return Response.json({ message: "请求格式不正确" }, { status: 400, headers: noStore });
    try {
      const { version: expected, ...patch } = input.data;
      const result = await updateLifeMemory(customerId, ownerId, memoryId, expected, patch);
      if (!result.ok) return Response.json({ message: result.error }, { status: 400, headers: noStore });
      return Response.json({ memory: result.memory }, { headers: noStore });
    } catch (error) {
      if (error instanceof Error && error.message === "MEMORY_NOT_FOUND") return Response.json({ message: "这条记忆不存在或已经删除。" }, { status: 404, headers: noStore });
      if (error instanceof Error && error.message === "MEMORY_STALE") return Response.json({ message: "这条记忆刚被改过，请刷新后再改。" }, { status: 409, headers: noStore });
      throw error;
    }
  } catch (error) { return apiError(error, "MEMORY_UPDATE_FAILED"); }
}

// 用户删除一条记忆：软删除，之后不再用于回答和提醒。
export async function DELETE(request: Request, context: RouteContext<"/api/v1/memories/[memoryId]">) {
  try {
    assertSameOrigin(request);
    const { customerId, ownerId } = await uiPrincipal(request);
    const { memoryId } = await context.params;
    const input = remove.safeParse(await request.json().catch(() => null));
    if (!input.success || !ownerId || !z.string().uuid().safeParse(memoryId).success) return Response.json({ message: "请求格式不正确" }, { status: 400, headers: noStore });
    try {
      await deleteLifeMemory(customerId, ownerId, memoryId, input.data.version);
      return Response.json({ ok: true }, { headers: noStore });
    } catch (error) {
      if (error instanceof Error && error.message === "MEMORY_NOT_FOUND") return Response.json({ message: "这条记忆不存在或已经删除。" }, { status: 404, headers: noStore });
      if (error instanceof Error && error.message === "MEMORY_STALE") return Response.json({ message: "这条记忆刚被改过，请刷新后再删。" }, { status: 409, headers: noStore });
      throw error;
    }
  } catch (error) { return apiError(error, "MEMORY_DELETE_FAILED"); }
}
