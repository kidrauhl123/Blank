import { notFound } from "next/navigation";
import { VoiceTraceDemo } from "@/features/voice-trace/VoiceTraceDemo";

export default function VoiceTracePreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <VoiceTraceDemo />;
}
