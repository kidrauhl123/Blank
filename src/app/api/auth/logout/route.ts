import { NextRequest, NextResponse } from "next/server";
import { logoutSession, SESSION_COOKIE } from "@/lib/auth";
import { apiError, assertSameOrigin } from "@/lib/http";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    await logoutSession(request.cookies.get(SESSION_COOKIE)?.value);
    const response = NextResponse.json({ status: "SIGNED_OUT" });
    response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax" });
    return response;
  } catch (error) { return apiError(error, "LOGOUT_FAILED"); }
}
