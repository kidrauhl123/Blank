import { resumeAgentRuntime, inspectAgentRun } from "@/lib/agent-runtime";
import { AuthError, authenticateRequest } from "@/lib/auth";
import { apiError, assertSameOrigin } from "@/lib/http";
import { withPreferenceScope } from "@/lib/preference-runtime";
import { resolveVisitorMemoryScope } from "@/lib/visitor-memory";

export async function POST(request: Request, context: RouteContext<"/api/agent/tasks/[taskId]/cancel">) {
  try {
    assertSameOrigin(request);
    const principal = await authenticateRequest(request);
    if (principal.kind !== "SESSION") throw new AuthError("AUTHORIZATION_REQUIRES_BANK_APP", 403);
    const { taskId } = await context.params;
    const scope = await resolveVisitorMemoryScope(request, principal.customerId);
    const agent = await withPreferenceScope(scope, async () => {
      const run = await inspectAgentRun(principal.customerId, taskId);
      if (!run?.operation_id) throw new Error("AGENT_RUN_NOT_FOUND");
      return resumeAgentRuntime({ customerId: principal.customerId, taskId, operationId: run.operation_id, approved: false });
    });
    return Response.json({ status: "CANCELLED", agent });
  } catch (error) {
    return apiError(error, "AGENT_CANCEL_FAILED");
  }
}
