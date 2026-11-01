import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { effectiveModelConfig } from "./model-config";
import { db, query } from "./db";
import { deleteVisitorModelKey, loadVisitorModelConfig, saveVisitorModelKey, visitorModelKeyStatus, withVisitorModel } from "./visitor-model-key";
import { verifyModelEndpoint } from "./model-endpoint";

// 不访问真实的模型接口：只替换“用这把密钥请求 /models”这一步。地址检查和加密都是真的。
vi.mock("./model-endpoint", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-endpoint")>();
  return { ...actual, verifyModelEndpoint: vi.fn(async () => ({ ok: true as const })) };
});

const KEY = "sk-visitor-only-key-9876";
const owners: string[] = [];

async function newOwner() {
  const id = randomUUID();
  await query("INSERT INTO visitor_memory_owners(id,token_hash) VALUES($1,$2)", [id, randomBytes(32).toString("hex")]);
  owners.push(id);
  return id;
}

describe.skipIf(process.env.BANKPILOT_DB_TESTS !== "1")("访客自己的模型接口（真实数据库）", () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.username !== "bankpilot_test") throw new Error("Use an isolated local bankpilot_test database role");
    if (!process.env.PASSWORD_PEPPER) throw new Error("Use a test-only PASSWORD_PEPPER");
  });
  afterAll(async () => {
    if (owners.length > 0) await query("DELETE FROM visitor_memory_owners WHERE id=ANY($1::uuid[])", [owners]);
    await db.end();
  });

  it("保存后只返回尾号，密钥加密存放且只对本访客可用", async () => {
    const owner = await newOwner();
    const saved = await saveVisitorModelKey(owner, { baseUrl: "https://8.8.8.8/v1", apiKey: KEY, model: "gpt-test-mini" });
    expect(saved).toMatchObject({ ok: true, status: { configured: true, baseUrl: "https://8.8.8.8/v1", model: "gpt-test-mini", keyHint: "9876" } });
    expect(JSON.stringify(saved)).not.toContain("sk-visitor-only");

    const raw = (await query<{ key_ciphertext: Buffer }>("SELECT key_ciphertext FROM visitor_model_keys WHERE owner_id=$1", [owner])).rows[0];
    expect(raw.key_ciphertext.toString("utf8")).not.toContain("sk-visitor-only");

    const config = await loadVisitorModelConfig(owner);
    expect(config).toMatchObject({ source: "VISITOR", baseUrl: "https://8.8.8.8/v1", apiKey: KEY, model: "gpt-test-mini" });

    const other = await newOwner();
    expect(await visitorModelKeyStatus(other)).toMatchObject({ configured: false });
    expect(await loadVisitorModelConfig(other)).toBeNull();
  });

  it("验证失败时什么都不保存", async () => {
    const owner = await newOwner();
    vi.mocked(verifyModelEndpoint).mockResolvedValueOnce({ ok: false, error: "MODEL_KEY_REJECTED" });
    expect(await saveVisitorModelKey(owner, { baseUrl: "https://8.8.8.8/v1", apiKey: KEY, model: "gpt-test-mini" })).toEqual({ ok: false, error: "MODEL_KEY_REJECTED" });
    expect(await visitorModelKeyStatus(owner)).toMatchObject({ configured: false });
  });

  it("地址不允许时不会去请求，也不保存", async () => {
    const owner = await newOwner();
    vi.mocked(verifyModelEndpoint).mockClear();
    expect(await saveVisitorModelKey(owner, { baseUrl: "https://127.0.0.1/v1", apiKey: KEY, model: "gpt-test-mini" })).toEqual({ ok: false, error: "MODEL_ENDPOINT_NOT_ALLOWED" });
    expect(verifyModelEndpoint).not.toHaveBeenCalled();
    expect(await visitorModelKeyStatus(owner)).toMatchObject({ configured: false });
  });

  it("请求期间只让这位访客使用自己的配置，删除后回到未配置", async () => {
    const owner = await newOwner();
    await saveVisitorModelKey(owner, { baseUrl: "https://8.8.8.8/v1", apiKey: KEY, model: "gpt-test-mini" });
    const seen = await withVisitorModel({ ownerId: owner, profileKey: "potato" }, async () => effectiveModelConfig());
    expect(seen).toMatchObject({ source: "VISITOR", model: "gpt-test-mini" });
    expect(seen?.fingerprint).toHaveLength(32);

    await deleteVisitorModelKey(owner);
    expect(await visitorModelKeyStatus(owner)).toMatchObject({ configured: false, keyHint: null });
    expect(await loadVisitorModelConfig(owner)).toBeNull();
  });

  it("同一地址同一密钥的指纹稳定，换一把密钥就不同", async () => {
    const owner = await newOwner();
    await saveVisitorModelKey(owner, { baseUrl: "https://8.8.8.8/v1", apiKey: KEY, model: "gpt-test-mini" });
    const first = await loadVisitorModelConfig(owner);
    await saveVisitorModelKey(owner, { baseUrl: "https://8.8.8.8/v1", apiKey: "sk-another-visitor-key-1111", model: "gpt-test-mini" });
    const second = await loadVisitorModelConfig(owner);
    expect(first?.fingerprint).not.toBe(second?.fingerprint);
    expect(second?.apiKey).toBe("sk-another-visitor-key-1111");
  });
});
