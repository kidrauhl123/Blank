import { z } from "zod";
import { authenticateRequest } from "@/lib/auth";
import { commitTransfer, prepareTransfer } from "@/lib/bank-core";
import { apiError, assertSameOrigin } from "@/lib/http";
import { resolveVisitorMemoryScope } from "@/lib/visitor-memory";
import { requestFeedCheck } from "@/lib/feed-store";

const schema = z.object({
  fromAccountId: z.string().uuid(),
  recipient: z.string().trim().min(2).max(50),
  amountMinor: z.number().int().positive().max(100_000_000),
  note: z.string().trim().max(80).optional(),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    const input = schema.parse(await request.json());
    // 没有访客 cookie 时没有任何规矩，走原来的确认流程。
    const scope = await resolveVisitorMemoryScope(request, principal.customerId);
    // 新设备登录后 24 小时内的大额转账进入反诈暂缓（新设备标记只来自服务端的会话记录）。
    const prepared = await prepareTransfer(principal.customerId, input, { ownerId: scope?.ownerId ?? null, newDevice: principal.newDevice === true });
    if ("ruleId" in prepared) {
      // 规矩内的转账直接过账；过账前会再判一次规矩，已经不覆盖就取消，资金不动。
      const done = await commitTransfer(principal.customerId, prepared.operationId, { totpCode: null, taskId: null });
      // 只有真正过账成功才能告诉用户“已转出”；取消或风险升高都按没有转出处理。
      if (done.status !== "SUCCEEDED") {
        return Response.json({ error: "RULE_NOT_EXECUTABLE", message: "规矩已变化（暂停、撤销、超出限额或当天转账较多），这笔没有转出，请照常确认。", reasons: "reasons" in done ? done.reasons : [] }, { status: 409 });
      }
      // 规矩内的转账成功也是事件：打上检查标记，由下一次调度 tick 判断首页动态。
      await requestFeedCheck(principal.customerId).catch(() => undefined);
      return Response.json({ ...done, viaRule: true, ruleId: prepared.ruleId, riskLevel: "GREEN", requiredAuth: "NONE" }, { status: 201 });
    }
    return Response.json(prepared, { status: 201 });
  } catch (error) {
    return apiError(error, "TRANSFER_PREPARE_FAILED");
  }
}
