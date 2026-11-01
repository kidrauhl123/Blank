import { describe, expect, it } from "vitest";
import { deviceKeyOf } from "./device-key";

describe("设备的粗略标识", () => {
  it("同一系统和浏览器的不同版本是同一个设备", () => {
    const chrome120 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const chrome121 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
    expect(deviceKeyOf(chrome120)).toBe("windows/chrome");
    expect(deviceKeyOf(chrome121)).toBe(deviceKeyOf(chrome120));
  });

  it("Chrome 的 UA 里带 Safari 字样，不能被认成 Safari；Edge 也单独区分", () => {
    expect(deviceKeyOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")).toBe("mac/chrome");
    expect(deviceKeyOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0")).toBe("windows/edge");
  });

  it("iPhone 上的 Safari 和 Chrome 是两个设备标识", () => {
    const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";
    const chromeIos = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1";
    expect(deviceKeyOf(safari)).toBe("ios/safari");
    expect(deviceKeyOf(chromeIos)).toBe("ios/chrome");
  });

  it("没有 UA 时用 unknown，不会抛错", () => {
    expect(deviceKeyOf(null)).toBe("unknown");
    expect(deviceKeyOf("   ")).toBe("unknown");
  });
});
