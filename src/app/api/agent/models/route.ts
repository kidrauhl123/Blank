import { authenticateRequest } from "@/lib/auth";
import { getAIModels } from "@/lib/ai-models";
import { apiError } from "@/lib/http";
import { resolveVisitorMemoryScope } from "@/lib/visitor-memory";
import { withVisitorModel } from "@/lib/visitor-model-key";

export async function GET(request: Request) {
  try {
    const principal = await authenticateRequest(request);
    const scope = await resolveVisitorMemoryScope(request, principal.customerId);
    return Response.json(await withVisitorModel(scope, () => getAIModels()), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiError(error, "AI_MODEL_CATALOG_UNAVAILABLE"); }
}
