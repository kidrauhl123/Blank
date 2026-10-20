import { chromium } from "@playwright/test";

// 截图脚本：桌面视口下把鼠标停在按钮上，画布里的圆点应当落在指针位置、按下时收缩。
const base = process.env.SHOT_BASE ?? "http://localhost:3109";
const out = process.env.SHOT_DIR ?? "docs/screenshots";

const overview = {
  customer: { display_name: "测试客户", phone: "99000000001", demo: true, mfa_configured: true }, totalMinor: 1280500,
  accounts: [{ id: "00000000-0000-4000-8000-000000000002", name: "活期账户", masked_no: "•• 1234", account_no: "test-only", currency: "CNY", status: "ACTIVE" }],
  cards: [{ id: "00000000-0000-4000-8000-000000000001", card_name: "日常卡", masked_no: "•••• 5678", card_type: "VIRTUAL", status: "ACTIVE", daily_limit_minor: "100000" }],
  transactions: [], subscriptions: [], ai: { configured: true, model: "deepseek-v4.1-flash-free" },
  statement: { month: "2026-10", expenseMinor: 0, categories: [], transactionCount: 0 },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.route("**/api/bootstrap", route => route.fulfill({ json: overview }));
await page.goto(base);
await page.locator("[data-phone-shell]").waitFor();

const point = page.locator("[data-touch-pointer]");
const dot = page.locator("[data-touch-dot]");
const measure = async () => {
  const b = await point.boundingBox();
  return { width: b.width, height: b.height, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
};

// 停在“转账”上：既看得见圆点，也能对照按钮的按压反馈。
const box = await page.getByRole("button", { name: "转账", exact: true }).boundingBox();
const at = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
await page.mouse.move(at.x, at.y);
await page.waitForTimeout(250);

const resting = await measure();
const restingDot = await dot.boundingBox();
if (resting.x !== at.x || resting.y !== at.y) throw new Error(`圆点没有落在指针上: ${resting.x},${resting.y} != ${at.x},${at.y}`);
if (resting.width !== resting.height) throw new Error(`圆点不是正圆: ${resting.width}x${resting.height}`);
await page.screenshot({ path: `${out}/touch-pointer-desktop.png` });

// 按下瞬间：圆点收缩到 68%，按钮同步出现按压态。等动画走完再截图。
await page.mouse.down();
await page.waitForTimeout(200);
const pressedDot = await dot.boundingBox();
if (pressedDot.width >= restingDot.width - 5) throw new Error(`按下后圆点没有收缩: ${pressedDot.width} >= ${restingDot.width}`);
// 收缩必须原地发生：中心点保持不动。
const dotCenter = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const c0 = dotCenter(restingDot), c1 = dotCenter(pressedDot);
if (Math.abs(c1.x - c0.x) > 1 || Math.abs(c1.y - c0.y) > 1) throw new Error(`收缩没有居中: ${JSON.stringify(c1)} vs ${JSON.stringify(c0)}`);
const scale = await dot.evaluate(n => getComputedStyle(n).scale);
if (scale !== "0.68") throw new Error(`按下后圆点没有收缩到 0.68: ${scale}`);
await page.screenshot({ path: `${out}/touch-pointer-pressed.png` });
await page.mouse.up();

// 手机视口：没有鼠标指针，也就没有圆点，只剩整屏画布。
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await phone.route("**/api/bootstrap", route => route.fulfill({ json: { ...overview, cards: [], accounts: [], totalMinor: 500000 } }));
await phone.goto(base);
await phone.locator("[data-phone-shell]").waitFor();
await phone.screenshot({ path: `${out}/touch-pointer-phone.png` });

await browser.close();
console.log(`ok resting=${restingDot.width}px pressed=${pressedDot.width.toFixed(1)}px at ${at.x},${at.y}`);
