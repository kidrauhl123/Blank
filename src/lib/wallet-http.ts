import { uiPrincipal } from "./ui-http";

// 规矩与钱包的接口都要银行会话 + 访客身份：规矩和钱包只属于创建它的访客。
export async function walletPrincipal(request: Request) {
  const principal = await uiPrincipal(request);
  if (!principal.ownerId) throw Object.assign(new Error("MEMORY_VISITOR_REQUIRED"), { status: 403 });
  return { customerId: principal.customerId, ownerId: principal.ownerId };
}
export const walletErrors: Record<string, [number, string]> = {
  RULE_NOT_FOUND: [404, "没有找到这条规矩。"],
  RULE_NOT_PENDING: [409, "这条规矩已经处理过，或者等得太久已过期，请让 Blank 重新提议。"],
  MFA_INVALID: [401, "验证器动态码不对，请重试。"],
  MFA_REPLAYED: [401, "这个动态码已经用过，请等下一个再试。"],
  AUTH_FUSE_ACTIVE: [423, "连续验证失败，强验证已暂停。请等待 15 分钟后再试，规矩没有生效。"],
  MFA_NOT_CONFIGURED: [409, "你还没有设置验证器。请先在安全中心设置，或者注册 Passkey（面容 / 指纹）。"],
  PASSKEY_INVALID: [401, "Passkey 验证没有通过，规矩没有生效。"],
};
