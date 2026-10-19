import { createHmac, timingSafeEqual } from "node:crypto";

function decodeBase32(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const char of secret.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("INVALID_TOTP_SECRET");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function codeAtStep(key: Buffer, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  const number = (digest.readUInt32BE(digest[digest.length - 1] & 15) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, "0");
}

/** Match +/- one 30-second step; consumption is a separate locked DB update. */
export function matchingTotpStep(secret: string, code: string, at: Date): number | null {
  if (!/^\d{6}$/.test(code) || !Number.isFinite(at.getTime()) || at.getTime() < 0) return null;
  const key = decodeBase32(secret);
  const counter = Math.floor(at.getTime() / 30_000);
  const matched = [-1, 0, 1].map(offset => counter + offset).filter(step => step >= 0)
    .filter(step => timingSafeEqual(Buffer.from(codeAtStep(key, step)), Buffer.from(code)));
  return matched.length ? Math.max(...matched) : null;
}
