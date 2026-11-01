import { createHash, randomBytes } from "node:crypto";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { query } from "./db";
import { ruleDigest, type RuleParams } from "./wallet-core";

// Passkey（WebAuthn）：立规矩的首选强验证——面容或指纹在用户自己的设备上完成，私钥不离开设备。
// 凭据属于访客（演示账户由访客共用），所以别的访客的 Passkey 不能确认你的规矩。
const CHALLENGE_TTL_MS = 5 * 60_000;
// 只有校验过服务端挑战和设备签名的结果才带这个品牌：别处没法凭空构造一个“已验证”，授权规矩时类型就会拦住。
declare const verifiedPasskey: unique symbol;
export type PasskeyProof = { method: "PASSKEY"; ruleId: string; readonly [verifiedPasskey]: true };
export function relyingParty(request: Request) {
  const origin = new URL(process.env.BANKPILOT_PUBLIC_URL || request.url).origin;
  return { origin, rpID: new URL(origin).hostname };
}
type Rp = ReturnType<typeof relyingParty>;

async function saveChallenge(ownerId: string, purpose: string, challenge: string) {
  await query("INSERT INTO passkey_challenges(owner_id,purpose,challenge,expires_at) VALUES($1,$2,$3,$4)", [ownerId, purpose, challenge, new Date(Date.now() + CHALLENGE_TTL_MS)]);
}
// 每个挑战只能用一次，过期作废。
async function takeChallenge(ownerId: string, purpose: string) {
  const row = await query<{ challenge: string }>(`UPDATE passkey_challenges SET used_at=now() WHERE id=(
    SELECT id FROM passkey_challenges WHERE owner_id=$1 AND purpose=$2 AND used_at IS NULL AND expires_at>now() ORDER BY expires_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING challenge`, [ownerId, purpose]);
  return row.rows[0]?.challenge ?? null;
}
const credentialsOf = (ownerId: string) => query<{ credential_id: string; public_key: Buffer; counter: string; transports: string[] }>(
  "SELECT credential_id,public_key,counter,transports FROM passkey_credentials WHERE owner_id=$1", [ownerId]);

export async function passkeyRegistrationOptions(customerId: string, ownerId: string, rp: Rp) {
  const [identity, existing] = await Promise.all([query<{ display_name: string }>("SELECT display_name FROM customers WHERE id=$1", [customerId]), credentialsOf(ownerId)]);
  const options = await generateRegistrationOptions({
    rpName: "Blank", rpID: rp.rpID, userName: `${identity.rows[0]?.display_name ?? "Blank"} · 访客`, userID: new TextEncoder().encode(ownerId), attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    excludeCredentials: existing.rows.map(row => ({ id: row.credential_id, transports: row.transports })),
  });
  await saveChallenge(ownerId, "register", options.challenge);
  return options;
}
export async function verifyPasskeyRegistration(customerId: string, ownerId: string, response: RegistrationResponseJSON, rp: Rp) {
  const expectedChallenge = await takeChallenge(ownerId, "register");
  if (!expectedChallenge) return false;
  const verification = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true }).catch(() => null);
  if (!verification?.verified) return false;
  const { credential } = verification.registrationInfo;
  await query("INSERT INTO passkey_credentials(owner_id,customer_id,credential_id,public_key,counter,transports) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(credential_id) DO NOTHING",
    [ownerId, customerId, credential.id, Buffer.from(credential.publicKey), credential.counter, credential.transports ?? []]);
  return true;
}

// 规矩的授权挑战：把规矩编号、规矩内容的摘要和一次性随机数一起做哈希。设备签的因此是“这一条规矩的这些参数”，换一条规矩或改了参数都对不上。
export async function passkeyAuthenticationOptions(ownerId: string, ruleId: string, rp: Rp) {
  const rule = (await query<{ params: RuleParams }>("SELECT params FROM wallet_rules WHERE id=$1 AND owner_id=$2 AND status='DRAFT'", [ruleId, ownerId])).rows[0];
  if (!rule) return null;
  const credentials = await credentialsOf(ownerId);
  if (!credentials.rowCount) return null;
  const digest = ruleDigest("pay_trusted_small", rule.params);
  const nonce = randomBytes(16).toString("hex");
  const challenge = createHash("sha256").update(`blank-rule-v1|${ruleId}|${digest}|${nonce}`).digest("base64url");
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required",
    allowCredentials: credentials.rows.map(row => ({ id: row.credential_id, transports: row.transports })) });
  // 库只会生成它自己的随机挑战，没有传入自定义挑战的入口，所以只能在生成后覆盖；校验时 expectedChallenge 用的也是这个值。
  options.challenge = challenge;
  await saveChallenge(ownerId, `rule:${ruleId}`, challenge);
  return options;
}
export async function verifyPasskeyAuthentication(ownerId: string, ruleId: string, response: AuthenticationResponseJSON, rp: Rp): Promise<PasskeyProof | null> {
  const expectedChallenge = await takeChallenge(ownerId, `rule:${ruleId}`);
  if (!expectedChallenge) return null;
  const stored = (await credentialsOf(ownerId)).rows.find(row => row.credential_id === response.id);
  if (!stored) return null;
  const verification = await verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
    credential: { id: stored.credential_id, publicKey: new Uint8Array(stored.public_key), counter: Number(stored.counter), transports: stored.transports } }).catch(() => null);
  if (!verification?.verified) return null;
  await query("UPDATE passkey_credentials SET counter=$2,last_used_at=now() WHERE credential_id=$1", [stored.credential_id, verification.authenticationInfo.newCounter]);
  return { method: "PASSKEY", ruleId } as PasskeyProof;
}
