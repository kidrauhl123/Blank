import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

// 一次请求使用的模型接口：访客自己填写的（source 为 VISITOR），或服务器运营方配置的（OPERATOR）。
export type ModelConfig = {
  source: "VISITOR" | "OPERATOR";
  baseUrl: string;
  apiKey: string;
  model: string;
  // 只用来区分不同的配置（缓存键），不能从它反推出密钥。
  fingerprint: string;
};

const modelScope = new AsyncLocalStorage<ModelConfig | null>();

export function modelFingerprint(baseUrl: string, apiKey: string) {
  return createHash("sha256").update(`${baseUrl}\n${apiKey}`).digest("hex").slice(0, 32);
}

// 运营方的配置来自服务器环境变量。访客没有自己的配置时才会用到。
export function operatorModelConfig(): ModelConfig | null {
  const baseUrl = process.env.AI_BASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL;
  if (!baseUrl || !apiKey || !model) return null;
  return { source: "OPERATOR", baseUrl, apiKey, model, fingerprint: modelFingerprint(baseUrl, apiKey) };
}

// 当前请求的配置：访客自己的优先；没有时用运营方的；都没有就是 null（界面显示未配置）。
export function effectiveModelConfig(): ModelConfig | null {
  return modelScope.getStore() ?? operatorModelConfig();
}

export function withModelConfig<T>(config: ModelConfig | null, work: () => Promise<T>): Promise<T> {
  return modelScope.run(config, work);
}
