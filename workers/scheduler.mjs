import { setTimeout as delay } from "node:timers/promises";

const token = process.env.SCHEDULER_TOKEN;
if (!token || token.length < 32) throw new Error("SCHEDULER_TOKEN_REQUIRES_32_CHARACTERS");
const base = new URL(process.env.BANKPILOT_INTERNAL_URL || "http://127.0.0.1:3000");
if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("INVALID_INTERNAL_URL");
let stopped = false;
const shutdown = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { stopped = true; shutdown.abort(); });
while (!stopped) {
  try {
    const response = await fetch(new URL("/api/internal/scheduler/tick", base), {
      method: "POST", headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(65_000)]), redirect: "error",
    });
    if (!response.ok) throw new Error(`TICK_HTTP_${response.status}`);
    const result = await response.json();
    if (result.processed || result.reviews || result.posts) console.info(`[scheduler] processed ${result.processed} tasks, ${result.reviews ?? 0} AI reviews, ${result.posts ?? 0} feed posts`);
  } catch (error) {
    if (!stopped) console.error("[scheduler] tick failed", error instanceof Error && /^TICK_HTTP_\d+$/.test(error.message) ? error.message : "CONNECTION_OR_EXECUTION_ERROR");
  }
  try { await delay(15_000, undefined, { signal: shutdown.signal }); } catch { /* shutdown */ }
}
