import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openApiKey, sealApiKey } from "./model-key-vault";

const originalPepper = process.env.PASSWORD_PEPPER;

describe("访客模型密钥的加密存放", () => {
  beforeEach(() => { process.env.PASSWORD_PEPPER = "vault-test-pepper-only"; });
  afterEach(() => { process.env.PASSWORD_PEPPER = originalPepper; });

  it("加密后能原样解开，密文里看不到明文", () => {
    const sealed = sealApiKey("sk-test-visitor-secret-1234");
    expect(sealed.ciphertext.toString("utf8")).not.toContain("sk-test-visitor-secret");
    expect(openApiKey(sealed)).toBe("sk-test-visitor-secret-1234");
  });

  it("每次加密使用新的随机 IV", () => {
    const first = sealApiKey("sk-same-key-value");
    const second = sealApiKey("sk-same-key-value");
    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it("密文或认证标签被改动时拒绝解开", () => {
    const sealed = sealApiKey("sk-tamper-check-value");
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] ^= 0x01;
    expect(() => openApiKey({ ...sealed, ciphertext: flipped })).toThrow();
    const badTag = Buffer.from(sealed.tag);
    badTag[0] ^= 0x01;
    expect(() => openApiKey({ ...sealed, tag: badTag })).toThrow();
  });

  it("更换 PASSWORD_PEPPER 后已保存的密钥无法解开", () => {
    const sealed = sealApiKey("sk-pepper-bound-value");
    process.env.PASSWORD_PEPPER = "another-pepper-value";
    expect(() => openApiKey(sealed)).toThrow();
  });

  it("没有 PASSWORD_PEPPER 时拒绝加密", () => {
    delete process.env.PASSWORD_PEPPER;
    expect(() => sealApiKey("sk-no-pepper-value")).toThrow("PASSWORD_PEPPER_REQUIRED");
  });
});
