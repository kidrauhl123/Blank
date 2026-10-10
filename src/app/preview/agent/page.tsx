import { AgentInteractionPreview } from "@/components/AgentInteractionPreview";
import { notFound } from "next/navigation";

export default function AgentPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <AgentInteractionPreview />;
}
