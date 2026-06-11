import { describe, expect, test } from "bun:test";
import { createSecretRedactor, identityRedactor } from "../src/activities/redaction";

describe("workspace environment secret redaction", () => {
  test("replaces exact occurrences of secret values in nested payloads", () => {
    const redact = createSecretRedactor([
      { name: "API_TOKEN", value: "tok-1234567890" },
      { name: "DB_PASSWORD", value: "p4ssw0rd!" },
    ]);
    expect(redact("output: tok-1234567890 and p4ssw0rd!")).toBe("output: [redacted:API_TOKEN] and [redacted:DB_PASSWORD]");
    expect(redact({
      text: "value=tok-1234567890",
      nested: { items: ["clean", "p4ssw0rd!"], count: 2 },
    })).toEqual({
      text: "value=[redacted:API_TOKEN]",
      nested: { items: ["clean", "[redacted:DB_PASSWORD]"], count: 2 },
    });
  });

  test("redacts overlapping values longest-first", () => {
    const redact = createSecretRedactor([
      { name: "SHORT", value: "secret" },
      { name: "LONG", value: "secret-extended" },
    ]);
    expect(redact("a secret-extended b secret c")).toBe("a [redacted:LONG] b [redacted:SHORT] c");
  });

  test("skips values shorter than six characters to avoid false positives", () => {
    const redact = createSecretRedactor([{ name: "TINY", value: "abc" }]);
    expect(redact("abc appears verbatim")).toBe("abc appears verbatim");
  });

  test("returns the identity function when no usable secrets exist", () => {
    expect(createSecretRedactor([])).toBe(identityRedactor);
    const payload = { keep: "everything" };
    expect(identityRedactor(payload)).toBe(payload);
  });

  test("leaves non-plain objects untouched", () => {
    const redact = createSecretRedactor([{ name: "API_TOKEN", value: "tok-1234567890" }]);
    const when = new Date();
    expect(redact(when)).toBe(when);
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
  });
});
