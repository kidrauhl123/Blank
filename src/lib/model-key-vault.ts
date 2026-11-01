import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export type SealedApiKey = { ciphertext: Buffer; iv: Buffer; tag: Buffer };

// 加密密钥由 PASSWORD_PEPPER 经 HKDF 派生，用途与口令哈希分开。
// 更换 PASSWORD_PEPPER 后，已保存的访客密钥无法解开，需要访客重新填写。
function vaultKey() {
  const pepper = process.env.PASSWORD_PEPPER;
  if (!pepper) throw new Error("PASSWORD_PEPPER_REQUIRED");
  return Buffer.from(hkdfSync("sha256", Buffer.from(pepper, "utf8"), Buffer.from("bankpilot-model-key"), Buffer.from("visitor-model-key:v1"), 32));
}

export function sealApiKey(apiKey: string): SealedApiKey {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", vaultKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function openApiKey(sealed: SealedApiKey): string {
  const decipher = createDecipheriv("aes-256-gcm", vaultKey(), sealed.iv);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
}
