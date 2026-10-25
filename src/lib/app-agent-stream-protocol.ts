import type { AppAgentView } from "./app-agent-protocol";

export type AppAgentStreamEvent =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "result"; run: AppAgentView }
  | { type: "error"; message: string };
