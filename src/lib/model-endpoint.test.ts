import { describe, expect, it } from "vitest";
import { isPublicAddress, normalizeModelBaseUrl } from "./model-endpoint";

// 这些检查不需要网络：只用 IP 字面量，以及本机能解析的 localhost。
describe("模型接口地址的公开性检查", () => {
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "203.0.114.5",
    "2606:4700:4700::1111",
  ])("公开地址 %s 允许", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "100.64.0.1",          // 运营商级 NAT，也包括 Tailscale 地址段
    "169.254.169.254",     // 云元数据地址
    "172.16.0.1",
    "192.168.1.1",
    "0.0.0.0",
    "224.0.0.1",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",       // 同一个回环地址的十六进制映射写法
    "::ffff:c0a8:101",     // 192.168.1.1 的十六进制映射写法
    "64:ff9b::808:808",
  ])("非公开地址 %s 拒绝", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it("不是 IP 的字符串拒绝", () => {
    expect(isPublicAddress("example")).toBe(false);
  });
});

describe("模型接口地址的格式检查", () => {
  it("只接受 https 地址，并去掉末尾的斜杠", async () => {
    expect(await normalizeModelBaseUrl("https://8.8.8.8/v1/")).toEqual({ ok: true, baseUrl: "https://8.8.8.8/v1" });
  });

  it.each([
    "http://8.8.8.8/v1",
    "https://user:secret@8.8.8.8/v1",
    "https://8.8.8.8:8443/v1",
    "https://8.8.8.8/v1?debug=1",
    "https://8.8.8.8/v1#fragment",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://192.168.0.10/v1",
    "https://localhost/v1",
  ])("%s 不允许", async (address) => {
    expect(await normalizeModelBaseUrl(address)).toEqual({ ok: false, error: "MODEL_ENDPOINT_NOT_ALLOWED" });
  });

  it("不是地址的文字返回输入错误", async () => {
    expect(await normalizeModelBaseUrl("not a url")).toEqual({ ok: false, error: "MODEL_INPUT_INVALID" });
  });
});
