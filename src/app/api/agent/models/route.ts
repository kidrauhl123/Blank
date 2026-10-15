import { authenticateRequest } from "@/lib/auth";
import { getAIModels } from "@/lib/ai-models";
import { apiError } from "@/lib/http";

export async function GET(request: Request) {
  try {
    await authenticateRequest(request);
    return Response.json(await getAIModels(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiError(error, "AI_MODEL_CATALOG_UNAVAILABLE"); }
}
