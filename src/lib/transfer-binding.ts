import { createHash } from "node:crypto";

export type TransferBinding = {
  operationId: string;
  customerId: string;
  source: string;
  target: string;
  recipientCustomerId: string;
  recipientName: string;
  recipientPhone: string | null;
  recipientMasked: string;
  amountMinor: number;
  currency: string;
  note: string | null;
  expiresAt: string | Date;
};

export function transferFingerprint(value: TransferBinding) {
  // Fixed property order and normalized database values make the binding stable
  // across prepare/commit and independent of JSON key order supplied by callers.
  return createHash("sha256").update(JSON.stringify({
    version: 2,
    operationId: value.operationId,
    customerId: value.customerId,
    source: value.source,
    target: value.target,
    recipientCustomerId: value.recipientCustomerId,
    recipientName: value.recipientName,
    recipientPhone: value.recipientPhone,
    recipientMasked: value.recipientMasked,
    amountMinor: value.amountMinor,
    currency: value.currency.trim(),
    note: value.note,
    expiresAt: new Date(value.expiresAt).toISOString(),
  })).digest("hex");
}
