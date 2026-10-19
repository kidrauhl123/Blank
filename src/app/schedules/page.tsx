import type { Metadata } from "next";
import { ScheduledTasks } from "@/components/ScheduledTasks";
export const metadata: Metadata = { title: "定时任务 — BankPilot", robots: { index: false, follow: false } };
export default function SchedulesPage() { return <ScheduledTasks />; }
