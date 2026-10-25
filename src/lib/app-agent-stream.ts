import { AsyncLocalStorage } from "node:async_hooks";
import type { AppAgentStreamEvent } from "./app-agent-stream-protocol";

type StreamContext = { emit: (event: AppAgentStreamEvent) => void; signal: AbortSignal };
const streams = new AsyncLocalStorage<StreamContext>();
export function withAppAgentStream<T>(context: StreamContext, work: () => Promise<T>) {
  return streams.run(context, work);
}
export function currentAppAgentStream() { return streams.getStore(); }
