import { apiError } from "@/lib/http";
import { noStore } from "@/lib/ui-http";
import { walletOverview } from "@/lib/wallet-store";
import { walletPrincipal } from "@/lib/wallet-http";

export const dynamic = "force-dynamic";

// 规矩与钱包页的数据：钱包余额、规矩列表（含状态）、最近的钱包付款。
export async function GET(request: Request) {
  try {
    const { customerId, ownerId } = await walletPrincipal(request);
    return Response.json(await walletOverview(customerId, ownerId), { headers: noStore });
  } catch (error) { return apiError(error, "WALLET_UNAVAILABLE"); }
}
