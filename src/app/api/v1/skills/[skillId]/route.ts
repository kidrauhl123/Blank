import { z } from "zod";
import { apiError, assertSameOrigin } from "@/lib/http";
import { deleteCustomSkill, getCustomSkill, setCustomSkillEnabled, updateCustomSkill, type CustomSkillFailure } from "@/lib/custom-skill-store";
import { noStore, uiPrincipal } from "@/lib/ui-http";

export const dynamic = "force-dynamic";
const skillId = z.string().uuid();
const version = z.string().regex(/^\d{1,19}$/);
// 停用或启用，与修改内容是两种请求；先按停用/启用校验，不符合再按修改校验。
const toggle = z.object({ version, enabled: z.boolean() }).strict();
const edit = z.object({
  version, name: z.string(), description: z.string(), whenToUse: z.string(), steps: z.array(z.string()), notes: z.array(z.string()),
}).strict();
const remove = z.object({ version }).strict();
const STATUS: Record<CustomSkillFailure["code"], number> = { INVALID: 400, NOT_FOUND: 404, STALE: 409, DUPLICATE: 409, LIMIT: 409, EXPIRED: 409 };
const failed = (result: CustomSkillFailure) => Response.json({ message: result.error }, { status: STATUS[result.code], headers: noStore });

// 对话里的预览卡片和“我的做法”页面都用这个读取；只能读到自己访客范围内的做法。
export async function GET(request: Request, context: RouteContext<"/api/v1/skills/[skillId]">) {
  try {
    const { customerId, ownerId } = await uiPrincipal(request);
    const { skillId: id } = await context.params;
    if (!ownerId || !skillId.safeParse(id).success) return Response.json({ message: "没有找到这个做法。" }, { status: 404, headers: noStore });
    const skill = await getCustomSkill(customerId, ownerId, id);
    if (!skill) return Response.json({ message: "没有找到这个做法。" }, { status: 404, headers: noStore });
    return Response.json({ skill }, { headers: noStore });
  } catch (error) { return apiError(error, "SKILL_UNAVAILABLE"); }
}

// 用户在界面上停用、启用或修改自己的做法（自己的输入，不需要出现在对话里）。
export async function PATCH(request: Request, context: RouteContext<"/api/v1/skills/[skillId]">) {
  try {
    assertSameOrigin(request);
    const { customerId, ownerId } = await uiPrincipal(request);
    const { skillId: id } = await context.params;
    const body = await request.json().catch(() => null);
    if (!ownerId || !skillId.safeParse(id).success) return Response.json({ message: "请求格式不正确" }, { status: 400, headers: noStore });
    const toggled = toggle.safeParse(body);
    if (toggled.success) {
      const result = await setCustomSkillEnabled(customerId, ownerId, id, toggled.data.version, toggled.data.enabled);
      return result.ok ? Response.json({ skill: result.skill }, { headers: noStore }) : failed(result);
    }
    const edited = edit.safeParse(body);
    if (!edited.success) return Response.json({ message: "请求格式不正确" }, { status: 400, headers: noStore });
    const { version: expected, ...fields } = edited.data;
    const result = await updateCustomSkill(customerId, ownerId, id, expected, fields);
    return result.ok ? Response.json({ skill: result.skill }, { headers: noStore }) : failed(result);
  } catch (error) { return apiError(error, "SKILL_UPDATE_FAILED"); }
}

// 删除是软删除：之后既不能读取，也不在对话里被想起来。
export async function DELETE(request: Request, context: RouteContext<"/api/v1/skills/[skillId]">) {
  try {
    assertSameOrigin(request);
    const { customerId, ownerId } = await uiPrincipal(request);
    const { skillId: id } = await context.params;
    const input = remove.safeParse(await request.json().catch(() => null));
    if (!input.success || !ownerId || !skillId.safeParse(id).success) return Response.json({ message: "请求格式不正确" }, { status: 400, headers: noStore });
    const result = await deleteCustomSkill(customerId, ownerId, id, input.data.version);
    return result.ok ? Response.json({ ok: true }, { headers: noStore }) : failed(result);
  } catch (error) { return apiError(error, "SKILL_DELETE_FAILED"); }
}
