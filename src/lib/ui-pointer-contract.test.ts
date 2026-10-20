import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 画布把鼠标当作手指：样式表里不允许出现 hover 状态，也不允许给元素指定系统指针形态。
// 这条约束只靠人记会退回去，所以在这里盯着。
function styleFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return styleFiles(path);
    return path.endsWith(".css") ? [path] : [];
  });
}

const files = styleFiles(join(process.cwd(), "src"));
const globals = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const components = files.filter((file) => !file.endsWith(join("app", "globals.css")));

describe("phone canvas pointer contract", () => {
  it("has no hover state anywhere in the product styles", () => {
    const offenders = files.filter((file) => /:hover\b/.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => file.replace(process.cwd() + "/", ""))).toEqual([]);
  });

  it("leaves every system pointer shape to the one global rule", () => {
    const offenders = components.filter((file) => /(^|[\s;{])cursor:/.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => file.replace(process.cwd() + "/", ""))).toEqual([]);
  });

  it("hides the system cursor inside the canvas only on devices that have one", () => {
    expect(globals).toMatch(/@media \(pointer: fine\) \{\s*\[data-pointer="canvas"\]/);
    expect(globals).toContain('cursor: none');
    expect(globals).not.toMatch(/cursor: pointer/);
    expect(globals).not.toMatch(/cursor: not-allowed/);
  });

  it("removes the other desktop affordances: scrollbars, resize handles, text selection and number spinners", () => {
    expect(globals).toMatch(/\[data-pointer="canvas"\] textarea \{ resize: none; \}/);
    expect(globals).toMatch(/input\[type="number"\]::-webkit-input-spin-button|input\[type="number"\]::-webkit-inner-spin-button/);
    expect(globals).toMatch(/\[data-pointer="canvas"\],\s*\[data-pointer="canvas"\] \* \{ scrollbar-width: none; \}/);
    expect(globals).toMatch(/user-select: none/);
  });

  it("draws the round touch point with movement and shrink on separate elements", () => {
    const source = readFileSync(join(process.cwd(), "src/components/TouchPointer.tsx"), "utf8");
    const css = readFileSync(join(process.cwd(), "src/components/TouchPointer.module.css"), "utf8");

    // 画布上必须真的有一个圆形触点，而不是把系统指针换个形状而已。
    expect(source).toMatch(/data-touch-pointer/);
    expect(source).toMatch(/data-touch-dot/);

    // CSS 的 scale 在 transform 之前生效：位移与收缩写在同一元素上，按下的圆点
    // 会被一起缩掉、朝画布左上角跑。这一条就是那次回归的守卫。
    const block = (selector: string) => {
      const match = css.match(new RegExp(`\\${selector} \\{([^}]*)\\}`));
      const nested = css.match(new RegExp(`[^}]*\\${selector}[^{]*\\{([^}]*)\\}`));
      return (match?.[1] ?? nested?.[1] ?? "").replace(/\s+/g, " ");
    };
    expect(block(".pointer")).toContain("position: absolute");
    expect(block(".pointer")).not.toMatch(/[^-]scale:/);
    expect(block(".dot")).toMatch(/border-radius: 50%/);
    expect(block(".dot")).toMatch(/scale: 1/);
    expect(source).toContain("translate3d");
  });
});
