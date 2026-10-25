import { createHash } from "node:crypto";
import { AIConfigurationError, getAIStatus } from "./ai";

export type AIModelCatalog = { models: string[]; defaultModel: string };
let cache: { provider: string; expiresAt: number; catalog: AIModelCatalog } | undefined;
let pending: { provider: string; request: Promise<AIModelCatalog> } | undefined;

function blockedModels() {
  return new Set((process.env.AI_BLOCKED_MODELS ?? "").split(",").map(id => id.trim()).filter(Boolean));
}

function allowedModels() {
  return [...new Set((process.env.AI_ALLOWED_MODELS ?? "").split(",").map(id => id.trim()).filter(Boolean))];
}

export function isAIModelEnabled(model: string) {
  const allowed = allowedModels();
  return !blockedModels().has(model) && (!allowed.length || allowed.includes(model));
}

export function assertAIModelEnabled(model: string) {
  if (!isAIModelEnabled(model)) throw new Error("AI_MODEL_NOT_AVAILABLE");
}

export async function getAIModels(): Promise<AIModelCatalog> {
  if (!getAIStatus().configured) throw new AIConfigurationError();
  const baseURL = process.env.AI_BASE_URL!.replace(/\/$/, "");
  const key = process.env.AI_API_KEY!;
  const defaultModel = process.env.AI_MODEL!;
  const blocked = blockedModels();
  const allowed = allowedModels();
  const provider = createHash("sha256").update(JSON.stringify([baseURL, key, defaultModel, [...blocked].sort(), allowed])).digest("hex");
  if (cache?.provider === provider && cache.expiresAt > Date.now()) return cache.catalog;
  if (pending?.provider === provider) return pending.request;
  const request = (async () => {
    try {
      const response = await fetch(`${baseURL}/models`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000), cache: "no-store",
      });
      if (!response.ok) throw new Error("AI_MODEL_CATALOG_UNAVAILABLE");
      const body: unknown = await response.json();
      const data = body && typeof body === "object" && "data" in body ? body.data : null;
      if (!Array.isArray(data)) throw new Error("AI_MODEL_CATALOG_UNAVAILABLE");
      const available = new Set(data.flatMap((entry: unknown) => {
        const id = entry && typeof entry === "object" && "id" in entry ? entry.id : null;
        return typeof id === "string" && /^[a-zA-Z0-9._:/+-]{1,160}$/.test(id) && !blocked.has(id) ? [id] : [];
      }));
      const models = (allowed.length ? allowed.filter(id => available.has(id)) : [...available].sort()).slice(0, 200);
      if (!models.length) throw new Error("AI_MODEL_CATALOG_UNAVAILABLE");
      const catalog = { models, defaultModel: models.includes(defaultModel) ? defaultModel : models[0] };
      cache = { provider, expiresAt: Date.now() + 60_000, catalog };
      return catalog;
    } catch { throw new Error("AI_MODEL_CATALOG_UNAVAILABLE"); }
  })();
  pending = { provider, request };
  try { return await request; }
  finally { if (pending?.request === request) pending = undefined; }
}

export async function resolveAIModel(requested?: string) {
  if (!getAIStatus().configured) throw new AIConfigurationError();
  assertAIModelEnabled(requested || process.env.AI_MODEL!);
  if (!requested || requested === process.env.AI_MODEL) return process.env.AI_MODEL!;
  const { models } = await getAIModels();
  if (!models.includes(requested)) throw new Error("AI_MODEL_NOT_AVAILABLE");
  return requested;
}
