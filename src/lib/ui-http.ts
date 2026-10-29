import { AuthError, authenticateRequest } from "./auth";
import { resolveVisitorMemoryScope } from "./visitor-memory";

// 界面接口共用：必须是银行会话；访客身份决定“谁的界面”，请求里不能指定。
export async function uiPrincipal(request: Request) {
  const principal = await authenticateRequest(request);
  if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
  const scope = await resolveVisitorMemoryScope(request, principal.customerId);
  return { customerId: principal.customerId, ownerId: scope?.ownerId ?? null };
}
export const noStore = { "Cache-Control": "private, no-store" };
