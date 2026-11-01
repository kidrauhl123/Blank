import { z } from "zod";
import { apiError, assertSameOrigin } from "@/lib/http";
import { relyingParty, verifyPasskeyAuthentication } from "@/lib/passkey";
import { noStore } from "@/lib/ui-http";
import { authorizeRule, dismissRule, getRuleView, pauseRule, revokeRule } from "@/lib/wallet-store";
import { walletErrors, walletPrincipal } from "@/lib/wallet-http";

export const dynamic = "force-dynamic";
// 两种强验证（TOTP、Passkey）都用 action="authorize"，zod 的 discriminatedUnion 不允许同一个判别值出现两次，所以这里用普通的 union；每个分支都是 strict 的，不会互相误匹配。
const body = z.union([
  z.object({ action: z.literal("authorize"), method: z.literal("totp"), code: z.string().regex(/^\d{6}$/) }).strict(),
  z.object({ action: z.literal("authorize"), method: z.literal("passkey"), response: z.object({ id: z.string() }).passthrough() }).strict(),
  z.object({ action: z.literal("dismiss") }).strict(),
  z.object({ action: z.literal("revoke") }).strict(),
  z.object({ action: z.literal("pause") }).strict(),
]);
const fail = (code: string) => Response.json({ message: walletErrors[code]?.[1] ?? "请求没有完成。", error: code }, { status: walletErrors[code]?.[0] ?? 400, headers: noStore });

// 规矩卡由服务端按结构化参数渲染，对话里的预览读的就是这里。
export async function GET(request: Request, context: RouteContext<"/api/v1/rules/[ruleId]">) {
  try {
    const { customerId, ownerId } = await walletPrincipal(request);
    const { ruleId } = await context.params;
    const view = z.string().uuid().safeParse(ruleId).success ? await getRuleView(customerId, ownerId, ruleId) : null;
    return view ? Response.json({ rule: view }, { headers: noStore }) : fail("RULE_NOT_FOUND");
  } catch (error) { return apiError(error, "WALLET_UNAVAILABLE"); }
}

// 只有用户本人在 App 里的点击能走到这里：强验证、不要、撤销、暂停。模型没有任何工具能代做。
export async function POST(request: Request, context: RouteContext<"/api/v1/rules/[ruleId]">) {
  try {
    assertSameOrigin(request);
    const { customerId, ownerId } = await walletPrincipal(request);
    const { ruleId } = await context.params;
    const input = body.safeParse(await request.json().catch(() => null));
    if (!input.success || !z.string().uuid().safeParse(ruleId).success) return Response.json({ message: "请求格式不正确" }, { status: 400, headers: noStore });
    if (input.data.action === "dismiss") return (await dismissRule(customerId, ownerId, ruleId)) ? Response.json({ ok: true }, { headers: noStore }) : fail("RULE_NOT_PENDING");
    if (input.data.action === "revoke") return (await revokeRule(customerId, ownerId, ruleId)) ? Response.json({ ok: true }, { headers: noStore }) : fail("RULE_NOT_FOUND");
    if (input.data.action === "pause") return (await pauseRule(customerId, ownerId, ruleId)) ? Response.json({ ok: true }, { headers: noStore }) : fail("RULE_NOT_FOUND");
    let result;
    if (input.data.method === "totp") result = await authorizeRule(customerId, ownerId, ruleId, { method: "TOTP", code: input.data.code });
    else {
      const proof = await verifyPasskeyAuthentication(ownerId, ruleId, input.data.response as never, relyingParty(request));
      if (!proof) return fail("PASSKEY_INVALID");
      result = await authorizeRule(customerId, ownerId, ruleId, proof);
    }
    return result.ok ? Response.json({ ok: true }, { headers: noStore }) : fail(result.error);
  } catch (error) { return apiError(error, "WALLET_UNAVAILABLE"); }
}
