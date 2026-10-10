export const DEMO_PROFILES = [
  { key: "potato", name: "小土豆", emoji: "🥔", role: "职场新人", description: "工资、通勤与日常消费", initialMinor: 1580000, salaryMinor: 1250000, phone: "99000000001", color: "#eaf1d8" },
  { key: "chestnut", name: "小板栗", emoji: "🌰", role: "在校学生", description: "生活费、学习与朋友转账", initialMinor: 680000, salaryMinor: 300000, phone: "99000000002", color: "#f5eadb" },
  { key: "apple", name: "小苹果", emoji: "🍎", role: "小店经营者", description: "经营收入、采购与大额支出", initialMinor: 8800000, salaryMinor: 3200000, phone: "99000000003", color: "#e0efec" },
  { key: "watermelon", name: "小西瓜", emoji: "🍉", role: "家庭账本管理者", description: "家庭开支、缴费与代扣", initialMinor: 3500000, salaryMinor: 1600000, phone: "99000000004", color: "#f4e3e9" },
  { key: "orange", name: "小橘子", emoji: "🍊", role: "旅行爱好者", description: "出行消费、双卡与异常交易", initialMinor: 2600000, salaryMinor: 1450000, phone: "99000000005", color: "#e8e4f3" },
] as const;
export function publicDemoProfiles() {
  return DEMO_PROFILES.map(({ key, name, emoji, role, description, color }) => ({ key, name, emoji, role, description, color }));
}
