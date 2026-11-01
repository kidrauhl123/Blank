import type { Metadata } from "next";
import { LinksPage } from "@/components/LinksPage";
export const metadata: Metadata = { title: "家人与朋友 — Blank", robots: { index: false, follow: false } };
export default function LinksRoutePage() { return <LinksPage />; }
