import { AuthError, authenticateRequest } from "@/lib/auth";
import { query } from "@/lib/db";
import { buildFeed, type FeedSubscription, type FeedTransaction } from "@/lib/feed";
import { apiError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
    const [transactions, subscriptions] = await Promise.all([
      query<FeedTransaction & { amount_minor: string }>(
        `SELECT bt.id,bt.merchant_name,bt.category,bt.amount_minor,bt.occurred_at,bt.is_anomaly
         FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
         WHERE a.customer_id=$1 AND bt.occurred_at >= now() - interval '60 days'
         ORDER BY bt.occurred_at DESC LIMIT 500`,
        [principal.customerId],
      ),
      query<FeedSubscription & { amount_minor: string }>(
        "SELECT id,merchant_name,amount_minor,next_charge_at,status FROM subscriptions WHERE customer_id=$1",
        [principal.customerId],
      ),
    ]);
    const posts = buildFeed({
      transactions: transactions.rows.map(row => ({ ...row, amount_minor: Number(row.amount_minor), occurred_at: new Date(row.occurred_at).toISOString() })),
      subscriptions: subscriptions.rows.map(row => ({ ...row, amount_minor: Number(row.amount_minor), next_charge_at: new Date(row.next_charge_at).toISOString() })),
    });
    return Response.json({ posts }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error, "FEED_UNAVAILABLE");
  }
}
