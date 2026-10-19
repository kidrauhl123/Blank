import { assertSchedulerRequest } from "@/lib/scheduler-auth";
import { tickScheduledTasks } from "@/lib/scheduled-tasks";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    assertSchedulerRequest(request);
    // Clock and task selection come from the database, never the caller.
    return Response.json(await tickScheduledTasks());
  } catch (error) { return apiError(error, "SCHEDULER_FAILED"); }
}
