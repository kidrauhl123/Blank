import type { Metadata } from "next";
import { MemoriesPage } from "@/components/MemoriesPage";
export const metadata: Metadata = { title: "我记住的事 — Blank", robots: { index: false, follow: false } };
export default function MemoriesRoutePage() { return <MemoriesPage />; }
