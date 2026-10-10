export const DEMO_PROFILES = [
  { key: "potato", name: "小土豆", emoji: "🥔", initialMinor: 1580000, salaryMinor: 1250000, phone: "99000000001", color: "#eaf1d8" },
  { key: "chestnut", name: "小板栗", emoji: "🌰", initialMinor: 680000, salaryMinor: 300000, phone: "99000000002", color: "#f5eadb" },
  { key: "apple", name: "小苹果", emoji: "🍎", initialMinor: 8800000, salaryMinor: 3200000, phone: "99000000003", color: "#e0efec" },
  { key: "watermelon", name: "小西瓜", emoji: "🍉", initialMinor: 3500000, salaryMinor: 1600000, phone: "99000000004", color: "#f4e3e9" },
  { key: "orange", name: "小橘子", emoji: "🍊", initialMinor: 2600000, salaryMinor: 1450000, phone: "99000000005", color: "#e8e4f3" },
] as const;
export function publicDemoProfiles() {
  return DEMO_PROFILES.map(({ key, name, emoji, color }) => ({ key, name, emoji, color }));
}
