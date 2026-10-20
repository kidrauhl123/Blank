import { expect, test } from "@playwright/test";

const overview = {
  customer: { display_name: "测试客户", phone: "99000000001", demo: true, mfa_configured: false }, totalMinor: 500000,
  accounts: [{ id: "00000000-0000-4000-8000-000000000002", name: "活期账户", masked_no: "•• 1234", account_no: "test-only", currency: "CNY", status: "ACTIVE" }],
  cards: [], transactions: [], subscriptions: [], ai: { configured: false, model: "" },
  statement: { month: "2026-10", expenseMinor: 0, categories: [], transactionCount: 0 },
};

type Box = { x: number; y: number; width: number; height: number };
const center = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

test("the mouse becomes a round touch point inside the phone canvas", async ({ page }) => {
  await page.route("**/api/bootstrap", route => route.fulfill({ json: overview }));
  await page.goto("/");
  const canvas = page.locator("[data-phone-shell]");
  await expect(canvas).toBeVisible();
  const point = page.locator("[data-touch-pointer]");
  const dot = page.locator("[data-touch-dot]");

  // 还没有指针进入画布时不画触点。
  await expect(point).toHaveAttribute("data-visible", "false");
  expect(await canvas.evaluate((node) => getComputedStyle(node).cursor)).toBe("none");

  const box = (await canvas.boundingBox())!;
  const target = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  await page.mouse.move(target.x, target.y);
  await expect(point).toHaveAttribute("data-visible", "true");

  // 圆形、正方形、直径等于设计 token。
  const shape = await dot.evaluate((node) => {
    const style = getComputedStyle(node);
    return { radius: style.borderRadius, width: parseFloat(style.width), height: parseFloat(style.height) };
  });
  expect(shape.radius).toBe("50%");
  expect(shape.width).toBe(shape.height);
  expect(shape.width).toBeGreaterThanOrEqual(24);

  // 触点落在指针上：圆心就是鼠标位置。
  const resting = (await point.boundingBox())!;
  const restingCenter = center(resting);
  expect(Math.abs(restingCenter.x - target.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(restingCenter.y - target.y)).toBeLessThanOrEqual(1);

  // 跟着指针走，且始终在画布坐标系里。
  await page.mouse.move(target.x - 80, target.y - 60);
  const after = (await point.boundingBox())!;
  expect(Math.abs(after.x - resting.x)).toBeGreaterThan(40);
  expect(after.x).toBeGreaterThan(box.x);
  expect(after.x + after.width).toBeLessThan(box.x + box.width);
  await page.mouse.move(target.x, target.y);

  // 按下时收缩、松开还原：这是手指的反馈，不是 hover。
  await page.mouse.down();
  await expect(point).toHaveAttribute("data-pressed", "true");
  await expect.poll(async () => parseFloat(await dot.evaluate((node) => getComputedStyle(node).scale)), { timeout: 2000 }).toBeLessThan(0.9);
  // 收缩必须是原地发生的：中心点不动，只有直径变小。（CSS 的 scale 先于 transform
  // 生效，若把位移和收缩写在同一个元素上，圆点会朝画布左上角跑。）
  const pressedDot = (await dot.boundingBox())!;
  const pressedCenter = center(pressedDot);
  expect(pressedDot.width).toBeLessThan(shape.width - 5);
  expect(Math.abs(pressedCenter.x - target.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(pressedCenter.y - target.y)).toBeLessThanOrEqual(1);
  await page.mouse.up();
  await expect(point).not.toHaveAttribute("data-pressed");

  // 画布内的交互元素不再使用任何系统指针形态。
  for (const selector of ["button", "a", "input", "select"]) {
    const found = page.locator(`[data-phone-shell] ${selector}`).first();
    if (await found.count()) expect(await found.evaluate((node) => getComputedStyle(node).cursor)).toBe("none");
  }
});

test("no element keeps a desktop-only affordance: hover styles, native tooltips or resize handles", async ({ page }) => {
  await page.route("**/api/bootstrap", route => route.fulfill({ json: overview }));
  await page.goto("/");
  await expect(page.locator("[data-phone-shell]")).toBeVisible();

  const violations = await page.evaluate(() => {
    const canvas = document.querySelector("[data-phone-shell]")!;
    const problems: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of Array.from(rules)) {
        const selector = (rule as CSSStyleRule).selectorText;
        if (selector?.includes(":hover")) problems.push(`hover rule: ${selector}`);
      }
    }
    for (const element of Array.from(canvas.querySelectorAll("*"))) {
      if (element.hasAttribute("title")) problems.push(`title tooltip: ${element.tagName}`);
      const style = getComputedStyle(element);
      if (style.cursor !== "none") problems.push(`system cursor ${style.cursor}: ${element.tagName}`);
    }
    return problems;
  });
  expect(violations).toEqual([]);

  const textarea = page.locator("[data-phone-shell] textarea").first();
  if (await textarea.count()) expect(await textarea.evaluate((node) => getComputedStyle(node).resize)).toBe("none");
});
