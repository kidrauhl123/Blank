import type { AppAgentView } from "./app-agent-protocol";
import type { AppAgentStreamEvent } from "./app-agent-stream-protocol";

export async function requestAppAgent(body: Record<string, unknown>, onEvent?: (event: AppAgentStreamEvent) => void, signal?: AbortSignal): Promise<AppAgentView> {
  const response = await fetch("/api/agent/app", { method: "POST", headers: { "Content-Type": "application/json", Accept: onEvent ? "text/event-stream" : "application/json" }, body: JSON.stringify(body), signal });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "助手暂时不可用");
    return result;
  }
  if (!response.body) throw new Error("无法读取助手回复，请重试。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", result: AppAgentView | undefined;
  const consume = (packet: string) => {
    const data = packet.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    const event = JSON.parse(data) as AppAgentStreamEvent;
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "result") result = event.run;
    else onEvent?.(event);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      if (buffer.length > 262144) throw new Error("回复连接异常，请重试。");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
    if (!result) throw new Error("回复连接已中断，请重试。");
    return result;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
