import { z } from "zod";
import { requireAppSession } from "@/lib/app-session";
import { getSessionModel, setSessionModel } from "@/lib/model-settings";
import { apiError } from "@/lib/http";
import { resolveVisitorMemoryScope } from "@/lib/visitor-memory";
import { withVisitorModel } from "@/lib/visitor-model-key";

export async function GET(request: Request) {
  try {
    const session = await requireAppSession(request);
    const scope = await resolveVisitorMemoryScope(request, session.customerId);
    return Response.json({ model: await withVisitorModel(scope, () => getSessionModel(session)) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiError(error, "MODEL_SETTINGS_UNAVAILABLE"); }
}

export async function PUT(request: Request) {
  try {
    const session = await requireAppSession(request);
    const input = z.object({ model: z.string().min(1).max(160) }).strict().safeParse(await request.json().catch(() => null));
    if (!input.success) return Response.json({ error: "INVALID_MODEL_SELECTION", message: "请选择有效的模型。" }, { status: 400 });
    const scope = await resolveVisitorMemoryScope(request, session.customerId);
    return Response.json(await withVisitorModel(scope, () => setSessionModel(session, input.data.model)));
  } catch (error) { return apiError(error, "MODEL_SETTINGS_FAILED"); }
}
