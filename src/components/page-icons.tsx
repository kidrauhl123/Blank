import { CalendarDays, ChartPie, Coffee, Gift, Heart, LayoutGrid, ListChecks, PiggyBank, Plane, Star, Users, Wallet, type LucideIcon } from "lucide-react";
import type { PageIcon } from "@/lib/ui-schema";

const ICONS: Record<PageIcon, LucideIcon> = { grid: LayoutGrid, coffee: Coffee, plane: Plane, users: Users, piggy: PiggyBank, chart: ChartPie, list: ListChecks, star: Star, calendar: CalendarDays, heart: Heart, gift: Gift, wallet: Wallet };
export function PageIconMark({ icon, size = 21 }: { icon: PageIcon; size?: number }) {
  const Icon = ICONS[icon] ?? LayoutGrid;
  return <Icon size={size} />;
}
