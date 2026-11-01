import { listLifeMemories } from "@/lib/life-memory";
import { apiError } from "@/lib/http";
import { noStore, uiPrincipal } from "@/lib/ui-http";

export const dynamic = "force-dynamic";

// 用户查看自己记住的事（生活事件和偏好）。没有访客身份就没有记忆。
export async function GET(request: Request) {
  try {
    const { customerId, ownerId } = await uiPrincipal(request);
    return Response.json({ memories: ownerId ? await listLifeMemories(customerId, ownerId) : [] }, { headers: noStore });
  } catch (error) { return apiError(error, "MEMORY_UNAVAILABLE"); }
}
