import { describe, expect, it } from "vitest";
import { BANK_KNOWLEDGE, KNOWLEDGE_TOPICS, searchBankKnowledge } from "./bank-knowledge";

describe("本行知识库", () => {
  it("每条都有唯一编号、来源、版本和生效日期，正文不超过 160 字", () => {
    const ids = BANK_KNOWLEDGE.map(item => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of BANK_KNOWLEDGE) {
      expect(KNOWLEDGE_TOPICS).toContain(item.topic);
      expect(item.document).not.toBe("");
      expect(item.section).toMatch(/^\d+\.\d+$/);
      expect(item.version).toMatch(/^\d{4}\.\d{2}$/);
      expect(item.effectiveOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.body.length).toBeLessThanOrEqual(160);
    }
  });

  it("按问题找到对应条目，并返回来源与版本日期", () => {
    expect(searchBankKnowledge("重复扣款怎么办")[0]).toMatchObject({ id: "dispute-duplicate-charge", source: "客户权益与争议处理办法 1.1", version: "2026.10", effectiveOn: "2026-10-01" });
    expect(searchBankKnowledge("存款证明要带什么")[0].id).toBe("cert-deposit");
    expect(searchBankKnowledge("被骗了，让我转到安全账户")[0].id).toBe("fraud-hotline");
  });

  it("没有相关内容时返回空，不把常用词带出无关条目", () => {
    expect(searchBankKnowledge("火星基地怎么办")).toEqual([]);
    expect(searchBankKnowledge("   ")).toEqual([]);
  });

  it("可以按主题缩小范围", () => {
    expect(searchBankKnowledge("还款", "cross-border")).toEqual([]);
    expect(searchBankKnowledge("还款", "credit")[0].id).toBe("credit-card-repay");
  });
});
