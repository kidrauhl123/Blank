import { describe, expect, it } from "vitest";
import { beijingClock, findBranches } from "./bank-branches";
import { estimateCnyYuan, getFxRates } from "./fx-rates";

// 2026-11-01 是周日，2026-11-02 是周一（北京时间）。
const MONDAY_10 = new Date("2026-11-02T02:00:00Z");
const MONDAY_18 = new Date("2026-11-02T10:00:00Z");
const SUNDAY_10 = new Date("2026-11-01T02:00:00Z");

describe("演示网点与 ATM", () => {
  it("按北京时间计算星期和分钟", () => {
    expect(beijingClock(new Date("2026-11-01T16:30:00Z"))).toEqual({ day: 1, minutes: 30 });
  });

  it("工作日营业时间内显示营业，周日只在周六窗口之外显示不营业", () => {
    expect(findBranches({ keyword: "朝阳支行", now: MONDAY_10 }).matches[0]).toMatchObject({ name: "朝阳支行", openNow: true, todayHours: "09:00–17:00" });
    expect(findBranches({ keyword: "朝阳支行", now: MONDAY_18 }).matches[0]).toMatchObject({ openNow: false });
    expect(findBranches({ keyword: "朝阳支行", now: SUNDAY_10 }).matches[0]).toMatchObject({ openNow: false, todayHours: "今日不营业" });
  });

  it("按城市、服务类型筛选，ATM 全天可取现", () => {
    expect(findBranches({ keyword: "上海", now: MONDAY_10 }).matches.map(item => item.name)).toEqual(["陆家嘴支行", "陆家嘴地铁站 ATM"]);
    expect(findBranches({ service: "fx", now: MONDAY_10 }).matches.map(item => item.name)).toEqual(["朝阳支行", "陆家嘴支行", "福田支行"]);
    expect(findBranches({ keyword: "大悦城", now: SUNDAY_10 }).matches[0]).toMatchObject({ kind: "自助设备", openNow: true, todayHours: "24 小时" });
    expect(findBranches({ keyword: "火星", now: MONDAY_10 }).matches).toEqual([]);
  });
});

describe("参考汇率", () => {
  it("标明是参考中间价，不是成交价", () => {
    const all = getFxRates();
    expect(all.rateDate).toBe("2026-10-31");
    expect(all.rates).toHaveLength(5);
    expect(all.note).toContain("不是成交价");
    expect(getFxRates("USD").rates).toEqual([{ currency: "USD", name: "美元", midCnyPerUnit: 7.1 }]);
  });

  it("按参考中间价折算人民币，保留两位小数", () => {
    expect(estimateCnyYuan("USD", 1000)).toBe(7100);
    expect(estimateCnyYuan("JPY", 10000)).toBe(465);
  });
});
