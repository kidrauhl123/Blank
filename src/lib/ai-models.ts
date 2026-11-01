import { createHash } from "node:crypto";
import { AIConfigurationError } from "./ai";
import { effectiveModelConfig } from "./model-config";

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
  // 访客自己的接口不受运营方的屏蔽和允许名单限制：那是运营方自己网关的策略。
  if (effectiveModelConfig()?.source === "VISITOR") return;
  if (!isAIModelEnabled(model)) throw new Error("AI_MODEL_NOT_AVAILABLE");
}

export async function getAIModels(): Promise<AIModelCatalog> {
  const config = effectiveModelConfig();
  if (!config) throw new AIConfigurationError();
  // 访客自己的接口只列出他填写的那一个模型，不去拉取目录。
  if (config.source === "VISITOR") return { models: [config.model], defaultModel: config.model };
  const baseURL = config.baseUrl;
  const key = config.apiKey;
  const defaultModel = config.model;
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
  const config = effectiveModelConfig();
  if (!config) throw new AIConfigurationError();
  // 访客自己的接口只用他填写的模型；之前保存过的其他模型名不再生效。
  if (config.source === "VISITOR") return config.model;
  assertAIModelEnabled(requested || config.model);
  if (!requested || requested === config.model) return config.model;
  const { models } = await getAIModels();
  if (!models.includes(requested)) throw new Error("AI_MODEL_NOT_AVAILABLE");
  return requested;
}
