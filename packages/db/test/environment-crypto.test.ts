import { createCipheriv } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "../src/environment-crypto";

describe("workspace environment value encryption", () => {
  const key = new Uint8Array(Buffer.alloc(32, 3));
  const otherKey = new Uint8Array(Buffer.alloc(32, 4));

  test("round-trips values through the lossless v2 format", () => {
    const plaintext = "super-secret-value-1234567890";
    const stored = encryptEnvironmentValue(key, plaintext);
    expect(stored.startsWith("v2:")).toBe(true);
    expect(stored).not.toContain(plaintext);
    expect(decryptEnvironmentValue(key, stored)).toBe(plaintext);
  });

  test("round-trips multi-byte and multi-line values", () => {
    const plaintext = "line one\nline two: pässwörd ✓\n-----BEGIN KEY-----\nabc\n-----END KEY-----";
    expect(decryptEnvironmentValue(key, encryptEnvironmentValue(key, plaintext))).toBe(plaintext);
  });

  test("round-trips every UTF-16 code unit exactly", () => {
    const plaintext =
      `nul:${String.fromCharCode(0)}:` +
      `lone-high:${String.fromCharCode(0xd800)}:` +
      `lone-low:${String.fromCharCode(0xdc00)}:paired:\u{1f680}`;
    const decrypted = decryptEnvironmentValue(key, encryptEnvironmentValue(key, plaintext));
    expect([...decrypted].map((value) => value.codePointAt(0))).toEqual(
      [...plaintext].map((value) => value.codePointAt(0)),
    );
    expect(decrypted).toBe(plaintext);
  });

  test("continues to decrypt historical UTF-8 v1 values", () => {
    const iv = Buffer.alloc(12, 9);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const plaintext = "historical v1 pässwörd";
    const payload = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    expect(
      decryptEnvironmentValue(key, `v1:${iv.toString("base64")}:${payload.toString("base64")}`),
    ).toBe(plaintext);
  });

  test("uses a fresh random iv per encryption", () => {
    const first = encryptEnvironmentValue(key, "same value");
    const second = encryptEnvironmentValue(key, "same value");
    expect(first).not.toBe(second);
    expect(decryptEnvironmentValue(key, first)).toBe("same value");
    expect(decryptEnvironmentValue(key, second)).toBe("same value");
  });

  test("rejects unknown version prefixes without echoing the payload", () => {
    expect(() => decryptEnvironmentValue(key, "v3:abc:def")).toThrow(
      "unsupported environment value format",
    );
    expect(() => decryptEnvironmentValue(key, "not-encrypted")).toThrow(
      "unsupported environment value format",
    );
    expect(() => decryptEnvironmentValue(key, "v1:short")).toThrow(
      "unsupported environment value format",
    );
  });

  test("fails closed on auth-tag mismatch with a generic error", () => {
    const stored = encryptEnvironmentValue(key, "tamper-target-value");
    expect(() => decryptEnvironmentValue(otherKey, stored)).toThrow(
      "environment value decryption failed",
    );
    const parts = stored.split(":");
    const payload = Buffer.from(parts[2]!, "base64");
    payload[0] = payload[0]! ^ 0xff;
    const tampered = `${parts[0]}:${parts[1]}:${payload.toString("base64")}`;
    expect(() => decryptEnvironmentValue(key, tampered)).toThrow(
      "environment value decryption failed",
    );
  });

  test("rejects keys that are not exactly 32 bytes", () => {
    expect(() => encryptEnvironmentValue(new Uint8Array(16), "value")).toThrow("exactly 32 bytes");
    expect(() => decryptEnvironmentValue(new Uint8Array(31), "v2:abc:def")).toThrow(
      "exactly 32 bytes",
    );
  });
});
