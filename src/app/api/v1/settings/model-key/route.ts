import { z } from "zod";
import { requireAppSession } from "@/lib/app-session";
import { apiError, assertSameOrigin } from "@/lib/http";
import { resolveVisitorMemoryScope } from "@/lib/visitor-memory";
import { deleteVisitorModelKey, saveVisitorModelKey, visitorModelKeyStatus, type VisitorModelKeyStatus } from "@/lib/visitor-model-key";

// 访客自己的模型接口。接口从不返回密钥，只返回地址、模型名和尾号。
const bodySchema = z.object({
  baseUrl: z.string().trim().min(8).max(300),
  apiKey: z.string().trim().min(8).max(300),
  model: z.string().trim().min(1).max(160),
}).strict();

const NOT_CONFIGURED: VisitorModelKeyStatus = { configured: false, baseUrl: null, model: null, keyHint: null, updatedAt: null };
const messages: Record<string, string> = {
  MODEL_INPUT_INVALID: "请检查接口地址和模型名称。",
  MODEL_ENDPOINT_NOT_ALLOWED: "接口地址必须是公开的 https 地址，不能指向本机或内网，也不能带账号密码或非标准端口。",
  MODEL_KEY_REJECTED: "这个接口拒绝了这把密钥，请确认密钥和接口地址匹配。",
  MODEL_ENDPOINT_UNREACHABLE: "无法连接这个模型接口，或它不是 OpenAI 兼容的 /models 接口。",
  VISITOR_REQUIRED: "请先进入银行 APP，再保存自定义模型。",
};

export async function GET(request: Request) {
  try {
    const session = await requireAppSession(request);
    const scope = await resolveVisitorMemoryScope(request, session.customerId);
    const status = scope ? await visitorModelKeyStatus(scope.ownerId) : NOT_CONFIGURED;
    return Response.json(status, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiError(error, "MODEL_KEY_UNAVAILABLE"); }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireAppSession(request);
    const scope = await resolveVisitorMemoryScope(request, session.customerId);
    if (!scope) return Response.json({ error: "VISITOR_REQUIRED", message: messages.VISITOR_REQUIRED }, { status: 409 });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "MODEL_INPUT_INVALID", message: messages.MODEL_INPUT_INVALID }, { status: 400 });
    const result = await saveVisitorModelKey(scope.ownerId, parsed.data);
    if (!result.ok) return Response.json({ error: result.error, message: messages[result.error] }, { status: result.error === "MODEL_INPUT_INVALID" ? 400 : 422 });
    return Response.json(result.status, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiError(error, "MODEL_KEY_SAVE_FAILED"); }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireAppSession(request);
    const scope = await resolveVisitorMemoryScope(request, session.customerId);
    if (scope) await deleteVisitorModelKey(scope.ownerId);
    return Response.json(NOT_CONFIGURED, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiError(error, "MODEL_KEY_DELETE_FAILED"); }
}
