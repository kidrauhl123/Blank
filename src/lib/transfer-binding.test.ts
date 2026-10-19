import { describe, expect, it } from "vitest";
import { transferFingerprint, type TransferBinding } from "./transfer-binding";

const binding: TransferBinding = {
  operationId: "TRF-1", customerId: "payer", source: "source", target: "target",
  recipientCustomerId: "recipient", recipientName: "收款人", recipientPhone: "13800000000", recipientMasked: "•• 1234",
  amountMinor: 100, currency: "CNY", note: "午饭", expiresAt: "2030-01-01T00:10:00.000Z",
};

describe("transfer authorization binding", () => {
  it.each([
    ["operationId", "TRF-2"], ["customerId", "another-payer"], ["source", "other-source"],
    ["target", "other-target"], ["recipientCustomerId", "other-customer"], ["recipientName", "另一个收款人"],
    ["recipientPhone", "13900000000"], ["recipientMasked", "•• 9999"], ["amountMinor", 101],
    ["currency", "USD"], ["note", "晚饭"], ["expiresAt", "2030-01-01T00:20:00Z"],
  ])("invalidates the old authorization when %s changes", (key, value) => {
    expect(transferFingerprint({ ...binding, [key]: value })).not.toBe(transferFingerprint(binding));
  });
  it("normalizes timezone representations and database CHAR padding", () => {
    expect(transferFingerprint({ ...binding, currency: "CNY ", expiresAt: "2030-01-01T08:10:00+08:00" }))
      .toBe(transferFingerprint(binding));
  });
});
