import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, totpAt, verifyTotp } from "../src/worker/lib/totp";

// RFC 6238 appendix B, SHA-1 key "12345678901234567890" (8-digit values; the last 6 digits are the 6-digit code).
const SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"));

describe("TOTP", () => {
  it("matches the RFC 6238 test vectors", async () => {
    expect(SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(new TextDecoder().decode(base32Decode(SECRET))).toBe("12345678901234567890");
    for (const [t, code] of [[59, "94287082"], [1111111109, "07081804"], [1234567890, "89005924"], [2000000000, "69279037"]] as const) {
      expect(await totpAt(SECRET, Math.floor(t / 30), 8)).toBe(code);
      expect(await totpAt(SECRET, Math.floor(t / 30))).toBe(code.slice(2));
    }
  });

  it("accepts ±30 s drift and refuses reuse", async () => {
    const now = 1234567890_000;
    const step = Math.floor(now / 30_000);
    const code = await totpAt(SECRET, step);
    expect(await verifyTotp(SECRET, code, null, now)).toBe(step);
    expect(await verifyTotp(SECRET, code, null, now + 30_000)).toBe(step);
    expect(await verifyTotp(SECRET, code, null, now + 90_000)).toBeNull();
    expect(await verifyTotp(SECRET, code, step, now)).toBeNull(); // already used
    expect(await verifyTotp(SECRET, "12345", null, now)).toBeNull();
  });
});
