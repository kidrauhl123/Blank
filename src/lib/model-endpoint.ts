import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// 访客填写的模型接口会由服务器带着密钥去请求，所以地址必须是公开的 https 地址：
// 不能指向本机、内网、链路本地、Tailscale 等 100.64/10 地址，也不能带账号密码或非标准端口。

export type EndpointCheck = { ok: true; baseUrl: string } | { ok: false; error: "MODEL_INPUT_INVALID" | "MODEL_ENDPOINT_NOT_ALLOWED" };

function isPublicIPv4(address: string) {
  const [a, b, c] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIPv6(address: string) {
  const lower = address.toLowerCase();
  // IPv4 映射地址（::ffff:a.b.c.d 或十六进制写法 ::ffff:xxxx:yyyy）按内嵌的 IPv4 判断。
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isPublicIPv4(dotted[1]);
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const high = parseInt(hexMapped[1], 16), low = parseInt(hexMapped[2], 16);
    return isPublicIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  if (lower.startsWith("::")) return false;               // 未指定、回环和已废弃的兼容写法
  if (/^f[cd]/.test(lower)) return false;                  // fc00::/7 唯一本地地址
  if (/^fe[89ab]/.test(lower)) return false;               // fe80::/10 链路本地
  if (lower.startsWith("ff")) return false;                // 组播
  if (lower.startsWith("2001:db8:")) return false;         // 文档地址
  if (lower.startsWith("64:ff9b:")) return false;          // NAT64，保守拒绝
  return true;
}

export function isPublicAddress(address: string) {
  const version = isIP(address);
  if (version === 4) return isPublicIPv4(address);
  if (version === 6) return isPublicIPv6(address);
  return false;
}

// 主机名：IP 字面量直接判断；域名必须解析出来，且每个地址都是公开地址。
export async function hostIsPublic(hostname: string) {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return isPublicAddress(bare);
  try {
    const addresses = await lookup(bare, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(item => isPublicAddress(item.address));
  } catch {
    return false;
  }
}

export async function normalizeModelBaseUrl(raw: string): Promise<EndpointCheck> {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return { ok: false, error: "MODEL_INPUT_INVALID" }; }
  if (url.protocol !== "https:") return { ok: false, error: "MODEL_ENDPOINT_NOT_ALLOWED" };
  if (url.username || url.password || url.search || url.hash) return { ok: false, error: "MODEL_ENDPOINT_NOT_ALLOWED" };
  if (url.port && url.port !== "443") return { ok: false, error: "MODEL_ENDPOINT_NOT_ALLOWED" };
  if (!url.hostname || url.hostname.length > 253) return { ok: false, error: "MODEL_INPUT_INVALID" };
  if (!(await hostIsPublic(url.hostname))) return { ok: false, error: "MODEL_ENDPOINT_NOT_ALLOWED" };
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, baseUrl: `https://${url.hostname}${path}` };
}

// 用访客的密钥请求一次 /models：不跟随重定向，8 秒超时，响应必须是带 data 数组的 OpenAI 兼容格式。
export async function verifyModelEndpoint(baseUrl: string, apiKey: string): Promise<{ ok: true } | { ok: false; error: "MODEL_KEY_REJECTED" | "MODEL_ENDPOINT_UNREACHABLE" }> {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 401 || response.status === 403) return { ok: false, error: "MODEL_KEY_REJECTED" };
    if (!response.ok) return { ok: false, error: "MODEL_ENDPOINT_UNREACHABLE" };
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) return { ok: false, error: "MODEL_ENDPOINT_UNREACHABLE" };
    return { ok: true };
  } catch {
    return { ok: false, error: "MODEL_ENDPOINT_UNREACHABLE" };
  }
}
