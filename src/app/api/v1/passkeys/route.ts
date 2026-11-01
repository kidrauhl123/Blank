import { z } from "zod";
import { consumeCustomerTotp } from "@/lib/auth";
import { query, withTransaction } from "@/lib/db";
import { apiError, assertSameOrigin } from "@/lib/http";
import { passkeyAuthenticationOptions, passkeyRegistrationOptions, relyingParty, verifyPasskeyRegistration } from "@/lib/passkey";
import { noStore } from "@/lib/ui-http";
import { walletErrors, walletPrincipal } from "@/lib/wallet-http";

export const dynamic = "force-dynamic";
const body = z.discriminatedUnion("step", [
  z.object({ step: z.literal("register-options"), totpCode: z.string().regex(/^\d{6}$/) }).strict(),
  z.object({ step: z.literal("register-verify"), response: z.object({ id: z.string() }).passthrough() }).strict(),
  z.object({ step: z.literal("auth-options"), ruleId: z.string().uuid() }).strict(),
]);
// 注册新的强验证方式要本人的验证器动态码：只靠已登录的会话，等于谁拿到会话谁就能再加一把钥匙。
const totpFailure = {
  LOCKED: [423, "连续验证失败，强验证已暂时锁定，请稍后再试。"],
  REPLAYED: [401, "这个动态码已经用过，请等下一个再试。"],
  INVALID: [401, "验证器动态码不对，请重试。"],
} as const;

// Passkey 的注册与验证挑战。注册需要用户本人在设备上完成面容 / 指纹；挑战只能用一次、5 分钟过期。
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { customerId, ownerId } = await walletPrincipal(request);
    const input = body.safeParse(await request.json().catch(() => null));
    if (!input.success) return Response.json({ message: "请求格式不正确" }, { status: 400, headers: noStore });
    const rp = relyingParty(request);
    if (input.data.step === "register-options") {
      const totpCode = input.data.totpCode;
      const enrolled = await query("SELECT 1 FROM mfa_totp WHERE customer_id=$1 AND enabled_at IS NOT NULL", [customerId]);
      if (!enrolled.rowCount) return Response.json({ message: "请先在安全中心设置验证器，才能注册 Passkey。" }, { status: 409, headers: noStore });
      // 返回结果而不是抛异常：失败计数和动态码的使用记录要随事务提交。
      const outcome = await withTransaction(client => consumeCustomerTotp(customerId, totpCode, client));
      if (outcome !== "VERIFIED") return Response.json({ message: totpFailure[outcome][1] }, { status: totpFailure[outcome][0], headers: noStore });
      return Response.json(await passkeyRegistrationOptions(customerId, ownerId, rp), { headers: noStore });
    }
    if (input.data.step === "register-verify") {
      return (await verifyPasskeyRegistration(customerId, ownerId, input.data.response as never, rp))
        ? Response.json({ ok: true }, { headers: noStore }) : Response.json({ message: walletErrors.PASSKEY_INVALID[1] }, { status: 401, headers: noStore });
    }
    const options = await passkeyAuthenticationOptions(ownerId, input.data.ruleId, rp);
    return options ? Response.json(options, { headers: noStore }) : Response.json({ message: "还没有注册 Passkey，或者规矩不存在或已确认。" }, { status: 409, headers: noStore });
  } catch (error) { return apiError(error, "PASSKEY_UNAVAILABLE"); }
}
