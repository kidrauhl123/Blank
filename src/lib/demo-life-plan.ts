// 展示账户（小土豆）每天的生活：给定日期总是得到同样的事件，便于回放和测试。
// 金额与商户都是虚构的，只为让动态里的每类帖子都有真实流水可依。

export type LifeFriend = "chestnut" | "apple" | "watermelon" | "orange";
export type LifeEvent = {
  slot: string; time: string; label: string; category: string; amountMinor: number;
  kind: "spend" | "income" | "friend-in" | "friend-out" | "invest";
  anomaly?: boolean; friend?: LifeFriend; productCode?: string;
};

export const SHOWCASE_PROFILE = "potato";
export const LIFE_FRIENDS: Array<{ key: LifeFriend; name: string }> = [
  { key: "chestnut", name: "小板栗" }, { key: "apple", name: "小苹果" }, { key: "watermelon", name: "小西瓜" }, { key: "orange", name: "小橘子" },
];
// 小土豆在原有两项订阅之外的会员，扣费日分散在一个月里，时间线上总有临近的一项。
export const SHOWCASE_SUBSCRIPTIONS = [
  { merchant: "优腾视频会员", amountMinor: 3000, dayOffset: 3 },
  { merchant: "跃动健身", amountMinor: 2500, dayOffset: 11 },
  { merchant: "飞鸽云笔记", amountMinor: 1200, dayOffset: 21 },
];

const pick = <T,>(items: readonly T[], value: number) => items[Math.floor(value * items.length) % items.length];
const between = (value: number, low: number, high: number) => Math.round((low + value * (high - low)) / 100) * 100;
export const epochDay = (date: string) => Math.round(new Date(`${date}T12:00:00Z`).getTime() / 86_400_000);

// 每个日期、每个用途各自一个稳定的伪随机数。
function chance(date: string, salt: string) {
  let hash = 2166136261;
  for (const char of `${date}:${salt}`) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0) / 4294967296;
}

const friendName = (key: LifeFriend) => LIFE_FRIENDS.find(friend => friend.key === key)!.name;
// AA 聚餐由小土豆先付，第二天两位朋友各转回一份。
function aaDinner(date: string) {
  const total = between(chance(date, "aa"), 48000, 72000);
  const round = Math.floor(epochDay(date) / 10);
  const guests = [LIFE_FRIENDS[round % 4].key, LIFE_FRIENDS[(round + 1) % 4].key];
  return { total, share: Math.round(total / 3 / 100) * 100, guests, place: pick(["蜀九香火锅", "大渔铁板烧", "炉鱼烤鱼"], chance(date, "aa-place")) };
}
const previousDay = (date: string) => new Date(new Date(`${date}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);

export function planLifeDay(date: string): LifeEvent[] {
  const day = epochDay(date);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const workday = weekday >= 1 && weekday <= 5;
  const dom = Number(date.slice(8, 10));
  const events: LifeEvent[] = [];
  const spend = (slot: string, time: string, label: string, category: string, amountMinor: number, anomaly = false) =>
    events.push({ slot, time, label, category, amountMinor: -amountMinor, kind: "spend", ...(anomaly ? { anomaly } : {}) });

  if (dom === 1) spend("rent", "09:00", "安居寓 · 房租", "住房", 450000);
  if (dom === 10) events.push({ slot: "salary", time: "09:30", label: "上海栖云软件有限公司", category: "工资", amountMinor: 1250000, kind: "income" });
  if (dom === 25) events.push({ slot: "side-income", time: "16:00", label: "知更书局 · 稿费", category: "收入", amountMinor: 200000, kind: "income" });
  if (dom === 15) spend("power", "10:20", "申城电力", "生活缴费", between(chance(date, "power"), 16000, 26000));
  if (dom === 20) spend("phone", "08:05", "申城通信 · 话费", "生活缴费", 8800);
  // 每周一定投一笔 30 天持有期理财，所以总有持仓在倒数解封。
  if (weekday === 1) events.push({ slot: "invest", time: "10:00", label: "稳享 30 天 · 申购", category: "理财", amountMinor: -50000, kind: "invest", productCode: "SIM-H30" });

  if (workday) {
    if (chance(date, "coffee") < 0.75) spend("coffee", "08:35", pick(["漫拿咖啡", "星杯咖啡", "瑞星咖啡"], chance(date, "coffee-shop")), "餐饮", between(chance(date, "coffee-amount"), 2600, 3800));
    spend("metro", "08:50", "申城轨道交通", "交通", 500);
    spend("lunch", "12:20", pick(["老乡饭馆", "和府面馆", "沙县小吃", "麦香堡"], chance(date, "lunch-shop")), "餐饮", between(chance(date, "lunch"), 2400, 4600));
    if (chance(date, "dinner") < 0.35) spend("dinner", "19:40", pick(["饱了么外卖", "橙子外卖"], chance(date, "dinner-shop")), "餐饮", between(chance(date, "dinner-amount"), 3500, 6200));
  } else {
    if (chance(date, "coffee") < 0.4) spend("coffee", "10:30", "漫拿咖啡", "餐饮", 3200);
    if (weekday === 6) spend("groceries", "15:10", pick(["禾马鲜生", "山木会员商店"], chance(date, "grocery-shop")), "购物", between(chance(date, "groceries"), 15000, 26000));
    if (weekday === 0) spend("weekend-dining", "18:30", pick(["西北莜面村", "绿野私厨", "大渔铁板烧"], chance(date, "dining-shop")), "餐饮", between(chance(date, "dining"), 12000, 22000));
    if (chance(date, "ride") < 0.5) spend("ride", "21:15", "嘀嘀出行", "交通", between(chance(date, "ride-amount"), 1800, 4200));
  }

  if (day % 10 === 3) { const aa = aaDinner(date); spend("aa-dinner", "19:30", aa.place, "餐饮", aa.total); }
  if (day % 10 === 4) {
    const aa = aaDinner(previousDay(date));
    aa.guests.forEach((friend, index) => events.push({ slot: `aa-back-${friend}`, time: index ? "11:40" : "10:15", label: `来自${friendName(friend)}的转账`, category: "转账", amountMinor: aa.share, kind: "friend-in", friend }));
  }
  if (day % 15 === 8) {
    const friend = LIFE_FRIENDS[Math.floor(day / 15) % 4].key;
    events.push({ slot: `send-${friend}`, time: "21:10", label: `转账给${friendName(friend)}`, category: "转账", amountMinor: -pick([15000, 20000, 26000], chance(date, "send")), kind: "friend-out", friend });
  }
  // 约两周一次深夜大额消费，交给交易核查去发现。
  if (day % 12 === 7) spend("unusual", "23:40", pick(["上海澄光数码商行", "深港优品跨境", "NEXON 海外商店"], chance(date, "unusual-shop")), "购物", between(chance(date, "unusual"), 89900, 259900), true);

  return events.sort((a, b) => a.time.localeCompare(b.time) || a.slot.localeCompare(b.slot));
}
