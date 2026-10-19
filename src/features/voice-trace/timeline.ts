import type { TimelineEvent } from "@/lib/app-agent-protocol";
export type { TimelineEvent, TimelineState } from "@/lib/app-agent-protocol";

// The same event can arrive again after reconnecting. Keep its latest state,
// while preserving the server's order instead of the arrival order.
export function mergeTimelineEvents(previous: TimelineEvent[], incoming: TimelineEvent[]): TimelineEvent[] {
  const byId = new Map(previous.map((event) => [event.id, event]));
  for (const event of incoming) {
    const existing = byId.get(event.id);
    if (!existing || event.sequence === existing.sequence) byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}
