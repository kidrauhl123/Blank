import { z } from "zod";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { commitPreparedCardLock, commitTransfer } from "@/lib/bank-core";
import { writeAudit } from "@/lib/audit";
import { FraudHoldError } from "@/lib/fraud-store";
import { requestFeedCheck } from "@/lib/feed-store";
import { inspectAgentRun, resumeAgentRuntime } from "@/lib/agent-runtime";
import { apiError, assertSameOrigin } from "@/lib/http";
import { withPreferenceScope } from "@/lib/preference-runtime";
import { resolveVisitorMemoryScope } from "@/lib/visitor-memory";

const schema = z.object({
  confirmed: z.literal(true),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
  code: z.string().max(128).optional(),
  taskId: z.string().uuid().optional(),
  resourceId: z.string().uuid().optional(),
  type: z.enum(["TRANSFER", "CARD_LOCK", "SUBSCRIPTION_CANCEL"]),
});

export async function POST(request: Request, context: RouteContext<"/api/operations/[operationId]/commit">) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("AUTHORIZATION_REQUIRES_BANK_APP", 403);
    const input = schema.parse(await request.json());
    const { operationId } = await context.params;
    const scope = await resolveVisitorMemoryScope(request, principal.customerId);
    if (input.taskId) {
      // The visitor scope can legitimately disappear (cookie cleared, expired, or a
      // fresh browser). That must not block committing an operation the customer
      // already prepared: fall back to an unscoped inspection and only fail when
      // the task itself does not match, with an actionable message.
      const run = await withPreferenceScope(scope, () => inspectAgentRun(principal.customerId, input.taskId!));
      if (!run || run.operation_id !== operationId) {
        const unscoped = await withPreferenceScope(null, () => inspectAgentRun(principal.customerId, input.taskId!));
        if (!unscoped || unscoped.operation_id !== operationId) {
          throw new Error("AGENT_RUN_NOT_FOUND");
        }
        await writeAudit({
          customerId: principal.customerId,
          taskId: input.taskId,
          operationId,
          eventType: "AGENT_SCOPE_FALLBACK",
          actorType: "SYSTEM",
          summary: "访客记忆标识已变化，转账提交改用无访客范围的任务校验",
          evidence: { reason: "VISITOR_SCOPE_MISMATCH" },
        });
      }
    }
    if (input.type === "SUBSCRIPTION_CANCEL") throw new Error("NOT_IMPLEMENTED");
    let result;
    if (input.type === "TRANSFER") {
      result = await commitTransfer(principal.customerId, operationId, { totpCode: input.totpCode ?? input.code, taskId: input.taskId });
    } else {
      if (!input.resourceId || !input.taskId) throw new Error("RESOURCE_REQUIRED");
      result = await commitPreparedCardLock(principal.customerId, operationId, { resourceId: input.resourceId, taskId: input.taskId });
    }
    if ("authError" in result) return Response.json({
      ...result,
      error: result.authError,
      message: result.authError === "AUTH_REQUIRED" ? "转账需要强验证，资金未转出。请核对红色操作并输入动态码再次确认。"
        : result.authError === "AUTH_FUSE_ACTIVE" ? "连续验证失败，强验证已暂停。请等待 15 分钟后重新发起操作，资金未转出。"
          : "动态码无效或已使用，资金未转出。请使用新的动态码。",
      agentRuntime: "AWAITING_AUTH",
    }, { status: result.authError === "AUTH_REQUIRED" ? 409 : result.authError === "AUTH_FUSE_ACTIVE" ? 423 : 401 });
    let agent = null;
    let agentRuntime = input.taskId ? "PENDING_FINALIZATION" : "NOT_APPLICABLE";
    if (input.taskId) {
      try {
        const taskId = input.taskId;
        agent = await withPreferenceScope(scope, () => resumeAgentRuntime({
          customerId: principal.customerId,
          taskId,
          operationId,
          approved: true,
        }));
        agentRuntime = "COMPLETED";
      } catch (resumeError) {
        await writeAudit({
          customerId: principal.customerId,
          taskId: input.taskId,
          operationId,
          eventType: "AGENT_RESUME_DEFERRED",
          actorType: "SYSTEM",
          summary: "银行操作已完成，Agent 最终回复等待恢复",
          evidence: { error: resumeError instanceof Error ? resumeError.message : "UNKNOWN" },
        });
      }
    }
    // 转账成功是事件：打上检查标记，下一次调度 tick 就看看首页动态要不要更新（不在这里调模型）。
    if (input.type === "TRANSFER") await requestFeedCheck(principal.customerId).catch(() => undefined);
    return Response.json({ ...result, agent, agentRuntime });
  } catch (error) {
    // 反诈暂缓期内：资金未转出，告诉用户什么时候可以再办。
    if (error instanceof FraudHoldError) {
      return Response.json({ error: "FRAUD_HOLD_ACTIVE", message: `这笔转账被反诈守护暂缓，北京时间 ${new Date(new Date(error.holdUntil).getTime() + 8 * 3_600_000).toISOString().slice(11, 16)} 之后才能确认。资金未转出。`, holdUntil: error.holdUntil }, { status: 409 });
    }
    return apiError(error, "EXECUTION_FAILED");
  }
}
