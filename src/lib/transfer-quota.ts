import type { PoolClient } from "pg";
import { query } from "./db";

// A half-open Shanghai calendar day, independent of the database session zone.
// The caller supplies the bank's posting instant, never a client timestamp.
export async function readDailyTransferTotal(customerId: string, postingAt: string, client?: PoolClient) {
  const sql = `WITH bounds AS (
    SELECT date_trunc('day', $2::timestamptz AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' AS start_at,
           (date_trunc('day', $2::timestamptz AT TIME ZONE 'Asia/Shanghai') + interval '1 day') AT TIME ZONE 'Asia/Shanghai' AS end_at
  )
  SELECT coalesce(sum(t.amount_minor),0)::text AS total
  FROM transfers t CROSS JOIN bounds b
  WHERE t.customer_id=$1 AND t.status='SUCCEEDED'
    AND t.executed_at>=b.start_at AND t.executed_at<b.end_at`;
  const values = [customerId, postingAt];
  const result = client ? await client.query<{ total: string }>(sql, values) : await query<{ total: string }>(sql, values);
  return Number(result.rows[0].total);
}
