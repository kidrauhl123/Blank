import { z } from "zod";
import { authorizeVoiceBridge, readVoiceFacts, voiceConfiguration } from "@/lib/voice-context";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";
const input = z.discriminatedUnion("action", [z.object({ action: z.literal("connect") }).strict(), z.object({ action: z.literal("facts"), area: z.enum(["overview", "investments", "statement"]) }).strict()]);
export async function POST(request: Request) {
  try {
    const principal = await authorizeVoiceBridge(request);
    const body = input.parse(await request.json());
    const result = body.action === "connect" ? { customerId: principal.customerId, ...voiceConfiguration() } : await readVoiceFacts(principal.customerId, body.area);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: "INVALID_VOICE_REQUEST" }, { status: 400 });
    return apiError(error, "VOICE_CONTEXT_UNAVAILABLE");
  }
}
