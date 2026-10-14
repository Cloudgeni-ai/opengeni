import { describe, expect, test } from "bun:test";
import {
  decodeBase32,
  isValidTotpInput,
  parseTotpInput,
  TotpInputError,
  totpCode,
  totpCodeAtDispatch,
  totpCodeSync,
  type SecretClock,
  type TotpParams,
} from "../src/index";

function base32(ascii: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of new TextEncoder().encode(ascii)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= 0xff;
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

// RFC 6238 Appendix B.
const SEEDS = {
  SHA1: "12345678901234567890",
  SHA256: "12345678901234567890123456789012",
  SHA512: "1234567890123456789012345678901234567890123456789012345678901234",
} as const;
const VECTORS: Array<[number, string, string, string]> = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

describe("TOTP", () => {
  for (const [seconds, sha1, sha256, sha512] of VECTORS) {
    test(`RFC 6238 vectors at T=${seconds}`, async () => {
      const params = (algorithm: TotpParams["algorithm"]): TotpParams => ({
        secretBase32: base32(SEEDS[algorithm]),
        algorithm,
        digits: 8,
        periodSeconds: 30,
      });
      expect(await totpCode(params("SHA1"), seconds * 1000)).toBe(sha1);
      expect(await totpCode(params("SHA256"), seconds * 1000)).toBe(sha256);
      expect(await totpCode(params("SHA512"), seconds * 1000)).toBe(sha512);
    });
  }

  test("six-digit codes are the low digits", () => {
    const params: TotpParams = {
      secretBase32: base32(SEEDS.SHA1),
      algorithm: "SHA1",
      digits: 6,
      periodSeconds: 30,
    };
    expect(totpCodeSync(params, 59_000)).toBe("287082");
  });

  test("parses bare seeds tolerantly", () => {
    expect(parseTotpInput("jbsw y3dp-ehpk 3pxp")).toEqual({
      secretBase32: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA1",
      digits: 6,
      periodSeconds: 30,
    });
    expect(parseTotpInput("JBSWY3DPEHPK3PXP====").secretBase32).toBe("JBSWY3DPEHPK3PXP");
  });

  test("parses otpauth URIs", () => {
    expect(
      parseTotpInput(
        "otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA256&digits=8&period=60",
      ),
    ).toEqual({
      secretBase32: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA256",
      digits: 8,
      periodSeconds: 60,
    });
    expect(parseTotpInput("otpauth://totp/x?secret=jbswy3dpehpk3pxp").algorithm).toBe("SHA1");
  });

  test.each([
    "",
    "not base32!",
    "otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP",
    "otpauth://totp/x",
    "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=9",
    "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5",
    "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0",
  ])("rejects %p", (input) => {
    expect(() => parseTotpInput(input)).toThrow(TotpInputError);
    expect(isValidTotpInput(input)).toBe(false);
  });

  test("base32 decoding", () => {
    expect(new TextDecoder().decode(decodeBase32(base32("hello world")))).toBe("hello world");
  });

  test("dispatch waits for the next window when fewer than 3 s remain", async () => {
    const params = parseTotpInput("JBSWY3DPEHPK3PXP");
    let now = 30_000 * 1000 + 28_500; // 1.5 s left in the window
    const sleeps: number[] = [];
    const clock: SecretClock = {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    };
    const result = await totpCodeAtDispatch(params, clock);
    expect(sleeps).toEqual([1_500]);
    expect(result.code).toBe(totpCodeSync(params, 30_000 * 1000 + 30_000));
    expect(result.expiresAtMs).toBe(30_000 * 1000 + 60_000);
  });

  test("dispatch does not wait with enough time left", async () => {
    const params = parseTotpInput("JBSWY3DPEHPK3PXP");
    const now = 30_000 * 1000 + 10_000;
    let slept = false;
    const result = await totpCodeAtDispatch(params, {
      now: () => now,
      sleep: async () => {
        slept = true;
      },
    });
    expect(slept).toBe(false);
    expect(result.code).toBe(totpCodeSync(params, now));
    expect(result.expiresAtMs).toBe(30_000 * 1000 + 30_000);
  });
});
