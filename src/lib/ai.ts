import { z } from "zod";
import { GROUNDED_REPLY_PROMPT, PLANNER_SYSTEM_PROMPT } from "./bank-agent-prompts";

export type ConversationMessage = { role: "user" | "assistant"; content: string };

const intentSchema = z.enum([
  "TRANSFER",
  "BALANCE",
  "BILL_ANALYSIS",
  "SUBSCRIPTIONS",
  "CARD_LOCK",
  "UNKNOWN",
]);

const stepSchema = z.enum([
  "resolve_customer",
  "read_accounts",
  "parse_transfer",
  "resolve_beneficiary",
  "check_balance",
  "policy_check",
  "await_authorization",
  "post_ledger",
  "load_transactions",
  "aggregate_categories",
  "detect_anomalies",
  "identify_recurring",
  "calculate_monthly_cost",
  "resolve_card",
  "await_confirmation",
  "collect_missing_fields",
  "clarify_intent",
]);

export const understandingSchema = z.object({
  intent: intentSchema,
  confidence: z.number().min(0).max(1),
  entities: z.object({
    beneficiaryName: z.string().trim().min(1).max(50).nullable(),
    amountMinor: z.number().int().positive().max(100_000_000).nullable(),
    accountName: z.string().trim().min(1).max(50).nullable(),
    timeRange: z.string().trim().min(1).max(80).nullable(),
  }),
  steps: z.array(stepSchema).min(1).max(10),
  clarification: z.string().trim().min(1).max(200).nullable(),
});

export type AgentUnderstanding = z.infer<typeof understandingSchema>;

const groundedReplySchema = z.object({
  message: z.string().trim().min(1).max(500),
  suggestions: z.array(z.string().trim().min(1).max(40)).max(3).default([]),
});

export class AIConfigurationError extends Error {
  constructor() {
    super("AI_NOT_CONFIGURED");
  }
}

export class AIUpstreamError extends Error {
  constructor(message = "AI_UPSTREAM_FAILED") {
    super(message);
  }
}

export function getAIStatus() {
  const configured = Boolean(process.env.AI_BASE_URL && process.env.AI_API_KEY && process.env.AI_MODEL);
  return { configured, model: configured ? process.env.AI_MODEL : null };
}

function getConfig() {
  if (!getAIStatus().configured) throw new AIConfigurationError();
  return {
    baseUrl: process.env.AI_BASE_URL!.replace(/\/$/, ""),
    apiKey: process.env.AI_API_KEY!,
    model: process.env.AI_MODEL!,
    timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 30_000),
  };
}

function extractJson(content: string) {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return fenced.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new AIUpstreamError("AI_INVALID_JSON");
}

async function requestJson<T>(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  schema: z.ZodType<T>,
) {
  const config = getConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      console.error("AI upstream status", response.status);
      throw new AIUpstreamError(`AI_UPSTREAM_${response.status}`);
    }
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new AIUpstreamError("AI_EMPTY_RESPONSE");
    const parsed = schema.parse(JSON.parse(extractJson(content)));
    return {
      value: parsed,
      meta: {
        model: payload.model ?? config.model,
        promptTokens: payload.usage?.prompt_tokens ?? null,
        completionTokens: payload.usage?.completion_tokens ?? null,
      },
    };
  } catch (error) {
    if (error instanceof AIConfigurationError || error instanceof AIUpstreamError) throw error;
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw new AIUpstreamError("AI_SCHEMA_REJECTED");
    if (error instanceof Error && error.name === "AbortError") throw new AIUpstreamError("AI_TIMEOUT");
    throw new AIUpstreamError();
  } finally {
    clearTimeout(timeout);
  }
}

export async function understandWithAI(message: string, history: ConversationMessage[]) {
  const recentHistory = history.slice(-8).map((item) => ({ role: item.role, content: item.content.slice(0, 500) }));
  return requestJson(
    [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      ...recentHistory,
      { role: "user", content: message },
    ],
    understandingSchema,
  );
}

export async function composeGroundedReply(input: {
  userMessage: string;
  intent: AgentUnderstanding["intent"];
  state: "COMPLETED" | "AWAITING_INPUT" | "AWAITING_CONFIRMATION" | "AWAITING_MFA";
  facts: Record<string, unknown>;
}) {
  return requestJson(
    [
      { role: "system", content: GROUNDED_REPLY_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          USER_REQUEST: input.userMessage,
          INTENT: input.intent,
          STATE: input.state,
          BANK_FACTS: input.facts,
        }),
      },
    ],
    groundedReplySchema,
  );
}
