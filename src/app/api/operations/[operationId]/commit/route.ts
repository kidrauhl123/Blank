import { z } from "zod";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { commitPreparedCardLock, commitTransfer } from "@/lib/bank-core";
import { writeAudit } from "@/lib/audit";
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
      const run = await withPreferenceScope(scope, () => inspectAgentRun(principal.customerId, input.taskId!));
      if (!run || run.operation_id !== operationId) throw new Error("AGENT_RUN_NOT_FOUND");
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
      message: result.authError === "AUTH_REQUIRED" ? "转账需要强验证，资金未转出。请核对红色操作并输入动态码再次确认。" : "强验证失败，资金未转出",
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
    return Response.json({ ...result, agent, agentRuntime });
  } catch (error) {
    return apiError(error, "EXECUTION_FAILED");
  }
}
