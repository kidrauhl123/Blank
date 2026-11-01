// 演示网点与 ATM 数据。地址和电话是虚构的演示内容；营业状态按北京时间计算，节假日以公告为准。
export const BRANCH_SERVICES = ["queue", "fx", "account", "wealth", "cash"] as const;
export type BranchService = (typeof BRANCH_SERVICES)[number];

const SERVICE_LABEL: Record<BranchService, string> = { queue: "取号办理", fx: "换汇", account: "开户与账户", wealth: "理财咨询", cash: "存取现金" };
const WEEKDAYS = [1, 2, 3, 4, 5];
const SATURDAY = [6];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
type OpenWindow = { days: number[]; open: string; close: string };
export type BankBranch = {
  id: string; name: string; kind: "BRANCH" | "ATM"; city: string; district: string; address: string; phone: string;
  services: BranchService[]; windows: OpenWindow[];
};

export const BANK_BRANCHES: BankBranch[] = [
  { id: "BJ-CY-001", name: "朝阳支行", kind: "BRANCH", city: "北京", district: "朝阳区", address: "建国路 88 号 1 层（演示地址）", phone: "010-88880001",
    services: ["queue", "fx", "account", "wealth", "cash"], windows: [{ days: WEEKDAYS, open: "09:00", close: "17:00" }, { days: SATURDAY, open: "09:00", close: "12:00" }] },
  { id: "BJ-HD-002", name: "海淀支行", kind: "BRANCH", city: "北京", district: "海淀区", address: "中关村大街 10 号（演示地址）", phone: "010-88880002",
    services: ["queue", "account", "cash"], windows: [{ days: WEEKDAYS, open: "09:00", close: "17:00" }] },
  { id: "SH-PD-001", name: "陆家嘴支行", kind: "BRANCH", city: "上海", district: "浦东新区", address: "陆家嘴环路 1000 号（演示地址）", phone: "021-88880001",
    services: ["queue", "fx", "wealth", "account", "cash"], windows: [{ days: WEEKDAYS, open: "09:00", close: "17:30" }] },
  { id: "SZ-FT-001", name: "福田支行", kind: "BRANCH", city: "深圳", district: "福田区", address: "深南大道 6008 号（演示地址）", phone: "0755-88880001",
    services: ["queue", "fx", "cash"], windows: [{ days: WEEKDAYS, open: "09:30", close: "17:00" }] },
  { id: "ATM-BJ-CY-01", name: "朝阳大悦城旁 ATM", kind: "ATM", city: "北京", district: "朝阳区", address: "朝阳北路 101 号（演示地址）", phone: "010-88880001",
    services: ["cash"], windows: [{ days: EVERY_DAY, open: "00:00", close: "24:00" }] },
  { id: "ATM-SH-PD-01", name: "陆家嘴地铁站 ATM", kind: "ATM", city: "上海", district: "浦东新区", address: "世纪大道 100 号（演示地址）", phone: "021-88880001",
    services: ["cash"], windows: [{ days: EVERY_DAY, open: "00:00", close: "24:00" }] },
];

const WEEK_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const toMinutes = (clock: string) => { const [hour, minute] = clock.split(":").map(Number); return hour * 60 + minute; };

// 北京时间的星期（0 为周日）和当天已过的分钟数。
export function beijingClock(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const read = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return { day: WEEK_INDEX[read("weekday")], minutes: Number(read("hour")) * 60 + Number(read("minute")) };
}

export function isOpenAt(branch: BankBranch, now: Date) {
  const { day, minutes } = beijingClock(now);
  return branch.windows.some(window => window.days.includes(day) && minutes >= toMinutes(window.open) && minutes < toMinutes(window.close));
}

function todayHours(branch: BankBranch, day: number) {
  const windows = branch.windows.filter(window => window.days.includes(day));
  if (!windows.length) return "今日不营业";
  if (windows.length === 1 && windows[0].open === "00:00" && windows[0].close === "24:00") return "24 小时";
  return windows.map(window => `${window.open}–${window.close}`).join("、");
}

export function findBranches(input: { keyword?: string; service?: BranchService; now?: Date }) {
  const now = input.now ?? new Date();
  const keyword = input.keyword?.trim();
  const { day } = beijingClock(now);
  const matches = BANK_BRANCHES.filter(branch => (!input.service || branch.services.includes(input.service))
    && (!keyword || [branch.name, branch.city, branch.district, branch.address].some(text => text.includes(keyword))));
  return {
    checkedAt: now.toISOString(),
    matches: matches.map(branch => ({
      id: branch.id, name: branch.name, kind: branch.kind === "ATM" ? "自助设备" : "网点", city: branch.city, district: branch.district,
      address: branch.address, phone: branch.phone, services: branch.services.map(service => SERVICE_LABEL[service]),
      openNow: isOpenAt(branch, now), todayHours: todayHours(branch, day),
    })),
    scope: "演示网点数据，营业状态按北京时间计算；节假日以网点公告为准。没有命中时请询问城市或区域。",
  };
}
