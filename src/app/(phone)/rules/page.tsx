import type { Metadata } from "next";
import { RulesPage } from "@/components/RulesPage";
export const metadata: Metadata = { title: "规矩与钱包 — Blank", robots: { index: false, follow: false } };
export default function RulesRoutePage() { return <RulesPage />; }
