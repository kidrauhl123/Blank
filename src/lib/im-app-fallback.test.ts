import { describe, expect, it } from "vitest";
import { appFallbackMessage, appOnlyRequest } from "./im-app-fallback";

describe("IM 里只能在 App 完成的请求", () => {
  it("立规矩、做法、互联、页面设置、申购、预约、定时任务都给出“回 App 继续”的路径", () => {
    expect(appOnlyRequest("以后给小橘子 100 块以内的转账不用问我，立规矩")?.path).toBe("/rules");
    expect(appOnlyRequest("帮我记成一个做法：每次看咖啡花了多少")?.path).toBe("/skills");
    expect(appOnlyRequest("邀请我妈妈互联，只让她收到反诈提醒")?.path).toBe("/links");
    expect(appOnlyRequest("把首页改成只留理财")?.path).toBe("/");
    expect(appOnlyRequest("申购一万块的理财")?.feature).toContain("申购");
    expect(appOnlyRequest("明天帮我预约网点取号")?.path).toBe("/");
    expect(appOnlyRequest("每天提醒我还信用卡")?.path).toBe("/schedules");
  });

  it("查询、锁卡、转账等 IM 已经支持的请求不拦截", () => {
    expect(appOnlyRequest("帮我看看这个月花了多少")).toBeNull();
    expect(appOnlyRequest("余额是多少")).toBeNull();
    expect(appOnlyRequest("把我的卡锁了")).toBeNull();
    expect(appOnlyRequest("转 200 给小橘子")).toBeNull();
  });

  it("回复说明功能需要在 App 里完成，链接由公开地址和路径拼出", () => {
    const message = appFallbackMessage({ feature: "家人与朋友互联", path: "/links" }, "https://bank.example.test");
    expect(message).toBe("「家人与朋友互联」需要在 Blank App 里完成，本人确认后才会生效。回 App 继续：https://bank.example.test/links");
  });
});
