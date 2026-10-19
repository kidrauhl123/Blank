import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { loginDemoProfile } from "@/lib/demo";
import { publicDemoProfiles } from "@/lib/demo-catalog";
import { apiError } from "@/lib/http";
import { VISITOR_MEMORY_COOKIE, visitorMemoryCookieOptions } from "@/lib/visitor-memory";

export const dynamic = "force-dynamic";
const schema = z.object({ profileKey: z.string().max(32) }).strict();

export async function GET() {
  return NextResponse.json({ profiles: publicDemoProfiles() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  try {
    if (request.headers.has("authorization")) throw new AuthError("BANK_APP_SESSION_REQUIRED", 403);
    const origin = request.headers.get("origin");
    const expected = new URL(process.env.BANKPILOT_PUBLIC_URL || request.url).origin;
    if (!origin || origin !== expected) throw new AuthError("INVALID_ORIGIN", 403);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AuthError("DEMO_PROFILE_NOT_FOUND", 404);
    const result = await loginDemoProfile({ ...parsed.data, previousToken: request.cookies.get(SESSION_COOKIE)?.value, previousMemoryToken: request.cookies.get(VISITOR_MEMORY_COOKIE)?.value, userAgent: request.headers.get("user-agent") });
    const response = NextResponse.json({ customer: result.customer });
    response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expires));
    response.cookies.set(VISITOR_MEMORY_COOKIE, result.memoryToken, visitorMemoryCookieOptions());
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return apiError(error, "DEMO_LOGIN_FAILED");
  }
}
