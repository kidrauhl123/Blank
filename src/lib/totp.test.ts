import { describe, expect, it } from "vitest";
import { matchingTotpStep } from "./totp";

// RFC 6238 Appendix B SHA-1 vectors, reduced to this application's six digits.
// https://www.rfc-editor.org/rfc/rfc6238.html#appendix-B
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
describe("TOTP step matching", () => {
  it.each([
    [59, "287082"], [1111111109, "081804"], [1111111111, "050471"],
    [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"],
  ])("matches the published SHA-1 vector at %i seconds", (seconds, code) => {
    expect(matchingTotpStep(secret, code, new Date(Number(seconds) * 1000))).toBe(Math.floor(Number(seconds) / 30));
  });
  it("returns the original step across the allowed skew and rejects two-step drift", () => {
    for (const seconds of [29, 59, 89]) expect(matchingTotpStep(secret, "287082", new Date(seconds * 1000))).toBe(1);
    expect(matchingTotpStep(secret, "287082", new Date(119000))).toBeNull();
  });
  it.each(["", "28708", "0287082", "abcdef", "287082 "])("rejects malformed input %j", code => {
    expect(matchingTotpStep(secret, code, new Date(59000))).toBeNull();
  });
});
