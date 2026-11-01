import type { Metadata } from "next";
import { SkillsPage } from "@/components/SkillsPage";
export const metadata: Metadata = { title: "我的做法 — Blank", robots: { index: false, follow: false } };
export default function SkillsRoutePage() { return <SkillsPage />; }
