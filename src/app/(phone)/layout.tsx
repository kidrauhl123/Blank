import { PhoneShell } from "@/components/PhoneShell";

// Product routes share one fixed phone surface. Preview prototypes live outside
// this group on purpose.
export default function PhoneLayout({ children }: { children: React.ReactNode }) {
  return <PhoneShell>{children}</PhoneShell>;
}
