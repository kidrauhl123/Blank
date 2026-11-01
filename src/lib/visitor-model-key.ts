import { query } from "./db";
import { modelFingerprint, withModelConfig, type ModelConfig } from "./model-config";
import { openApiKey, sealApiKey } from "./model-key-vault";
import { hostIsPublic, normalizeModelBaseUrl, verifyModelEndpoint } from "./model-endpoint";
import type { VisitorMemoryScope } from "./visitor-memory";

// 访客自己的模型接口。只按访客（记忆归属）保存，别人用同一个模拟账户时看不到，也用不到。
const MODEL_ID = /^[a-zA-Z0-9._:/+-]{1,160}$/;

export type VisitorModelKeyStatus = {
  configured: boolean;
  baseUrl: string | null;
  model: string | null;
  keyHint: string | null;
  updatedAt: string | null;
};

const NOT_CONFIGURED: VisitorModelKeyStatus = { configured: false, baseUrl: null, model: null, keyHint: null, updatedAt: null };

export async function visitorModelKeyStatus(ownerId: string): Promise<VisitorModelKeyStatus> {
  const row = (await query<{ base_url: string; model: string; key_hint: string; updated_at: Date }>(
    "SELECT base_url, model, key_hint, updated_at FROM visitor_model_keys WHERE owner_id=$1", [ownerId],
  )).rows[0];
  if (!row) return NOT_CONFIGURED;
  return { configured: true, baseUrl: row.base_url, model: row.model, keyHint: row.key_hint, updatedAt: row.updated_at.toISOString() };
}

export type SaveModelKeyResult =
  | { ok: true; status: VisitorModelKeyStatus }
  | { ok: false; error: "MODEL_INPUT_INVALID" | "MODEL_ENDPOINT_NOT_ALLOWED" | "MODEL_KEY_REJECTED" | "MODEL_ENDPOINT_UNREACHABLE" };

// 先检查地址，再用这把密钥请求一次 /models 确认可用，最后才加密保存。失败时什么都不写入。
export async function saveVisitorModelKey(ownerId: string, input: { baseUrl: string; apiKey: string; model: string }): Promise<SaveModelKeyResult> {
  if (!MODEL_ID.test(input.model)) return { ok: false, error: "MODEL_INPUT_INVALID" };
  const endpoint = await normalizeModelBaseUrl(input.baseUrl);
  if (!endpoint.ok) return endpoint;
  const verified = await verifyModelEndpoint(endpoint.baseUrl, input.apiKey);
  if (!verified.ok) return verified;
  const sealed = sealApiKey(input.apiKey);
  await query(`INSERT INTO visitor_model_keys(owner_id,base_url,model,key_ciphertext,key_iv,key_tag,key_hint,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,now())
    ON CONFLICT (owner_id) DO UPDATE SET base_url=excluded.base_url, model=excluded.model, key_ciphertext=excluded.key_ciphertext,
      key_iv=excluded.key_iv, key_tag=excluded.key_tag, key_hint=excluded.key_hint, updated_at=now()`,
  [ownerId, endpoint.baseUrl, input.model, sealed.ciphertext, sealed.iv, sealed.tag, input.apiKey.slice(-4)]);
  return { ok: true, status: await visitorModelKeyStatus(ownerId) };
}

export async function deleteVisitorModelKey(ownerId: string) {
  await query("DELETE FROM visitor_model_keys WHERE owner_id=$1", [ownerId]);
}

// 每次请求都重新解密，并重新检查地址解析出的 IP：解析结果可能已经改变。地址不再公开时视为未配置。
export async function loadVisitorModelConfig(ownerId: string): Promise<ModelConfig | null> {
  const row = (await query<{ base_url: string; model: string; key_ciphertext: Buffer; key_iv: Buffer; key_tag: Buffer }>(
    "SELECT base_url, model, key_ciphertext, key_iv, key_tag FROM visitor_model_keys WHERE owner_id=$1", [ownerId],
  )).rows[0];
  if (!row) return null;
  const host = new URL(row.base_url).hostname;
  if (!(await hostIsPublic(host))) return null;
  const apiKey = openApiKey({ ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag });
  return { source: "VISITOR", baseUrl: row.base_url, apiKey, model: row.model, fingerprint: modelFingerprint(row.base_url, apiKey) };
}

// 路由里包住整个请求：这一请求里所有模型调用都用访客自己的配置（没有就回到运营方配置）。
export async function withVisitorModel<T>(scope: VisitorMemoryScope | null, work: () => Promise<T>): Promise<T> {
  const config = scope ? await loadVisitorModelConfig(scope.ownerId) : null;
  return withModelConfig(config, work);
}
