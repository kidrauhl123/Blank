import { z } from "zod";
import { apiError, assertSameOrigin } from "@/lib/http";
import { noStore } from "@/lib/ui-http";
import { moveWallet } from "@/lib/wallet-store";
import { walletPrincipal } from "@/lib/wallet-http";

export const dynamic = "force-dynamic";
const body = z.object({ action: z.enum(["fund", "withdraw"]), amountYuan: z.number().int().min(1).max(2000) }).strict();

// 把钱转入 Blank 钱包，或收回主账户。这是用户自己的钱在自己的账户之间挪动，用户点一下即可；钱包上限写死，免确认的损失封顶。
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { customerId, ownerId } = await walletPrincipal(request);
    const input = body.safeParse(await request.json().catch(() => null));
    if (!input.success) return Response.json({ message: "请输入 1 到 2000 之间的整数金额（元）" }, { status: 400, headers: noStore });
    const result = await moveWallet(customerId, ownerId, input.data.action === "fund" ? "in" : "out", input.data.amountYuan * 100);
    return result.ok ? Response.json(result, { headers: noStore }) : Response.json({ message: result.error }, { status: 409, headers: noStore });
  } catch (error) { return apiError(error, "WALLET_UNAVAILABLE"); }
}
