import { z } from "zod";
import { NextResponse } from "next/server";
import { AuthError, getCookieValue } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { requireVisitorMemoryScope, VISITOR_MEMORY_COOKIE, visitorMemoryCookieOptions } from "@/lib/visitor-memory";
import {
  PREFERENCE_KEYS,
  clearPreferences,
  deletePreference,
  getPreferenceState,
  savePreference,
  setPreferenceMemoryEnabled,
} from "@/lib/visitor-preferences";

export const dynamic = "force-dynamic";
const key = z.enum(PREFERENCE_KEYS);
const expectedVersion = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const saveSchema = z.object({ key, value: z.string().min(1).max(160), expectedVersion }).strict();
const toggleSchema = z.object({ enabled: z.boolean(), expectedVersion }).strict();
const deleteSchema = z.union([
  z.object({ key, expectedVersion }).strict(),
  z.object({ all: z.literal(true), expectedVersion }).strict(),
]);

function json(data: unknown) {
  return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
}

function failure(error: unknown) {
  const response = apiError(error, "PREFERENCE_REQUEST_FAILED");
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw new AuthError("PREFERENCE_INVALID", 400);
  return parsed.data;
}

export async function GET(request: Request) {
  try {
    const scope = await requireVisitorMemoryScope(request);
    return json(await getPreferenceState(scope));
  } catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  try {
    const scope = await requireVisitorMemoryScope(request);
    const input = await parseBody(request, saveSchema);
    const result = await savePreference(scope, input.key, input.value, input.expectedVersion);
    const response = json(result.state);
    const token = getCookieValue(request, VISITOR_MEMORY_COOKIE);
    if (token) response.cookies.set(VISITOR_MEMORY_COOKIE, token, visitorMemoryCookieOptions());
    return response;
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  try {
    const scope = await requireVisitorMemoryScope(request);
    const input = await parseBody(request, deleteSchema);
    const result = "key" in input
      ? await deletePreference(scope, input.key, input.expectedVersion)
      : await clearPreferences(scope, input.expectedVersion);
    return json({ ...result.state, deletedCount: result.changedCount });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  try {
    const scope = await requireVisitorMemoryScope(request);
    const input = await parseBody(request, toggleSchema);
    const result = await setPreferenceMemoryEnabled(scope, input.enabled, input.expectedVersion);
    return json(result.state);
  } catch (error) { return failure(error); }
}
