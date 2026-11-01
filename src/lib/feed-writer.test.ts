import { describe, expect, it } from "vitest";
import { acceptWrittenText } from "./feed-writer";

const draft = { title: "咖啡本周花了 ¥86.00", body: "本周 4 笔，比上周多 1 笔。" };

describe("主模型撰写的动态", () => {
  it("只改写文字、数字都来自草稿的，采用改写结果", () => {
    expect(acceptWrittenText(draft, { title: "这周的咖啡花费", body: "一共 4 笔，比上周多 1 笔。" })).toEqual({ title: "这周的咖啡花费", body: "一共 4 笔，比上周多 1 笔。" });
  });

  it("金额里的千分位逗号不影响比对", () => {
    const big = { title: "餐饮 ¥1,234.50", body: "本月 9 笔。" };
    expect(acceptWrittenText(big, { title: "餐饮花了 ¥1234.50", body: "本月 9 笔。" }).title).toBe("餐饮花了 ¥1234.50");
  });

  it("新增了草稿里没有的数字（包括改了数字），整条退回草稿", () => {
    expect(acceptWrittenText(draft, { title: "咖啡本周花了 ¥80.00", body: "本周 4 笔。" })).toEqual(draft);
    expect(acceptWrittenText(draft, { title: "咖啡本周花了 ¥86.00", body: "本周 5 笔。" })).toEqual(draft);
  });

  it("包含链接、界面标记或代码的，退回草稿", () => {
    expect(acceptWrittenText(draft, { title: "咖啡", body: "详情见 https://example.com" })).toEqual(draft);
    expect(acceptWrittenText(draft, { title: "咖啡", body: "请看 [[card:abc]]" })).toEqual(draft);
    expect(acceptWrittenText(draft, { title: "咖啡", body: "<b>加粗</b>" })).toEqual(draft);
  });
});
