import { z } from "zod";
import { query } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { apiError } from "@/lib/http";
import { assertSchedulerRequest } from "@/lib/scheduler-auth";

export const runtime = "nodejs";
const body = z.object({ ruleId: z.string().uuid() }).strict();

// 运维/演示专用：让一条已经强验证、正在冷静期的规矩立刻生效（拍宣传片和现场演示用，不可能等 24 小时）。
// 只接受调度器专用凭据；正常用户路径里没有任何办法缩短冷静期，这一步会写入审计。
export async function POST(request: Request) {
  try {
    assertSchedulerRequest(request);
    const input = body.parse(await request.json());
    const updated = await query<{ customer_id: string }>("UPDATE wallet_rules SET effective_at=now() WHERE id=$1 AND status='COOLING' AND effective_at>now() RETURNING customer_id", [input.ruleId]);
    if (!updated.rows[0]) return Response.json({ expedited: false }, { status: 404 });
    await writeAudit({ customerId: updated.rows[0].customer_id, actorType: "SYSTEM", eventType: "WALLET_RULE_COOLDOWN_SKIPPED", summary: "运维跳过了一条规矩的冷静期（演示用）", evidence: { ruleId: input.ruleId } });
    return Response.json({ expedited: true });
  } catch (error) { return apiError(error, "WALLET_EXPEDITE_FAILED"); }
}
