import { builtInSkillSummaries } from "@/lib/app-agent-skills";
import { listCustomSkills } from "@/lib/custom-skill-store";
import { apiError } from "@/lib/http";
import { noStore, uiPrincipal } from "@/lib/ui-http";

export const dynamic = "force-dynamic";

// “我的做法”页面：列出用户自己保存的做法，以及 Blank 自带的做法（只有名字和简介）。没有访客身份就没有自己的做法。
export async function GET(request: Request) {
  try {
    const { customerId, ownerId } = await uiPrincipal(request);
    return Response.json({ skills: ownerId ? await listCustomSkills(customerId, ownerId) : [], builtIn: builtInSkillSummaries() }, { headers: noStore });
  } catch (error) { return apiError(error, "SKILLS_UNAVAILABLE"); }
}
