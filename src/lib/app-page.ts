import { canApplyAction, type ActionResult, type AppPage, type PageAction } from "./app-agent-protocol";

function visible(element: HTMLElement) {
  return element.getClientRects().length > 0 && !element.closest('[hidden], [aria-hidden="true"]');
}
function fingerprint(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16);
}
function sensitive(element: Element) {
  return Boolean(element.closest('[data-agent-private], [data-agent-overlay]'))
    || element.matches('input[type="password"], [autocomplete="one-time-code"], [data-agent-permission="human"] input');
}

export function captureAppPage(root: HTMLElement): AppPage {
  const dialogs = Array.from(root.querySelectorAll<HTMLElement>('[role="dialog"]')).filter((element) => visible(element) && !element.closest("[data-agent-overlay]"));
  const scope = dialogs.at(-1) ?? root;
  const controls: AppPage["controls"] = [];
  for (const element of scope.querySelectorAll<HTMLElement>("[data-agent-id]")) {
    if (!visible(element) || sensitive(element)) continue;
    const permission = element.dataset.agentPermission;
    if (!["navigate", "fill", "prepare", "human"].includes(permission ?? "")) continue;
    const input = element instanceof HTMLInputElement || element instanceof HTMLSelectElement;
    const label = element.dataset.agentLabel ?? element.getAttribute("aria-label") ?? (input ? element.closest("label")?.textContent : element.textContent) ?? "";
    controls.push({
      id: element.dataset.agentId!, label: label.trim().slice(0, 180),
      kind: element instanceof HTMLSelectElement ? "select" : input ? "input" : "button",
      permission: permission as AppPage["controls"][number]["permission"],
      disabled: element.hasAttribute("disabled"),
      ...(input && permission === "fill" ? { value: element.value.slice(0, 200) } : {}),
      ...(element instanceof HTMLSelectElement ? { options: Array.from(element.options).map((option) => option.value).slice(0, 30) } : {}),
    });
  }
  const clone = scope.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[hidden], [data-agent-overlay], [data-agent-private], script, style, input, select, textarea").forEach((node) => node.remove());
  const text = (clone.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 8000);
  const name = dialogs.at(-1)?.getAttribute("aria-label") ?? root.dataset.agentPage ?? "手机银行";
  const body = { name, text, controls: controls.slice(0, 100) };
  return { ...body, version: fingerprint(JSON.stringify(body)) };
}

export type PageMotion = { x: number; y: number; phase: "moving" | "typing" | "clicking" | "resting" };
type Presentation = { onMotion?: (motion: PageMotion | null) => void; reducedMotion?: boolean };
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function applyPageAction(root: HTMLElement, action: PageAction, stillInControl: () => boolean, presentation: Presentation = {}): Promise<ActionResult> {
  const before = captureAppPage(root);
  const blocked = canApplyAction(action, before);
  if (blocked || !stillInControl()) return { status: blocked === "PAGE_CHANGED" ? "USER_CHANGED" : "BLOCKED", message: blocked ?? "CONTROL_PAUSED", page: before };
  if (action.type === "inspect") return { status: "OBSERVED", message: "当前页面", page: before };
  if (action.type === "question" || action.type === "handoff") throw new Error("USER_REQUIRED");
  const reduced = presentation.reducedMotion ?? (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  if (action.type === "scroll") {
    const dialog = Array.from(root.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(element => visible(element) && !element.closest("[data-agent-overlay]")).at(-1);
    const viewport = dialog ?? root.querySelector<HTMLElement>("[data-agent-viewport]");
    if (!viewport) return { status: "BLOCKED", message: "SCROLL_UNAVAILABLE", page: before };
    viewport.scrollBy({ top: (action.direction === "down" ? 1 : -1) * viewport.clientHeight * 0.65, behavior: reduced ? "instant" : "smooth" });
    await delay(reduced ? 0 : 350);
    if (!stillInControl()) return { status: "USER_CHANGED", message: "用户已接管，滚动已暂停", page: captureAppPage(root) };
  } else {
    // Never interpolate model output into a selector, script, URL, or HTML.
    const element = Array.from(root.querySelectorAll<HTMLElement>("[data-agent-id]")).find((node) => node.dataset.agentId === action.target);
    if (!element || sensitive(element)) return { status: "BLOCKED", message: "TARGET_UNAVAILABLE", page: before };
    element.scrollIntoView({ block: "nearest", behavior: "instant" });
    // 画布本身就是手机：指针坐标相对画布，不用浏览器视口坐标。
    const frame = root.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const point = { x: Math.min(rect.right - 8, rect.left + rect.width * .65) - frame.left, y: rect.top + rect.height / 2 - frame.top };
    element.setAttribute("data-agent-highlight", "true");
    presentation.onMotion?.({ ...point, phase: "moving" });
    try {
      await delay(reduced ? 100 : 550);
      // Re-read after the visible highlight: the user may have intervened.
      if (!stillInControl() || captureAppPage(root).version !== before.version) return { status: "USER_CHANGED", message: "用户接管或页面变化，未执行该动作", page: captureAppPage(root) };
      if (action.type === "click") {
        presentation.onMotion?.({ ...point, phase: "clicking" });
        element.click();
      } else if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
        if (element instanceof HTMLInputElement && action.value.length > (element.maxLength > 0 ? element.maxLength : 200)) return { status: "BLOCKED", message: "FIELD_VALUE_TOO_LONG", page: before };
        const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
        const setValue = (value: string) => {
          Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        };
        presentation.onMotion?.({ ...point, phase: "typing" });
        const characters = Array.from(action.value);
        const values = reduced || element instanceof HTMLSelectElement || !characters.length ? [action.value]
          : characters.map((_, index) => characters.slice(0, index + 1).join(""));
        let expectedVersion = before.version;
        for (const value of values) {
          const current = captureAppPage(root);
          if (!stillInControl() || !element.isConnected || current.version !== expectedVersion || canApplyAction({ ...action, pageVersion: current.version }, current)) {
            return { status: "USER_CHANGED", message: "填写已暂停，保留当前内容供用户核对", page: current };
          }
          setValue(value);
          await Promise.resolve();
          expectedVersion = captureAppPage(root).version;
          await delay(reduced ? 0 : Math.max(9, Math.min(75, 1600 / Math.max(characters.length, 1))));
        }
        if (!stillInControl() || captureAppPage(root).version !== expectedVersion) return { status: "USER_CHANGED", message: "填写后用户已接管，请核对当前内容", page: captureAppPage(root) };
        element.setAttribute("data-agent-filled", "true");
        element.title = "助手已填写，请核对";
      }
      await delay(reduced ? 0 : 200);
    } finally {
      element.removeAttribute("data-agent-highlight");
      presentation.onMotion?.(null);
    }
  }
  await delay(100);
  return { status: "APPLIED", message: "页面动作已执行，不代表银行业务已完成", page: captureAppPage(root) };
}
