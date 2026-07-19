import { describe, expect, test } from "bun:test";
import {
  canonicalSessionCreateJson,
  fingerprintSessionCreateRequest,
  fingerprintSessionMcpCredentialHeaders,
} from "../src/domain/session-create-fingerprint";

describe("session create request fingerprint", () => {
  test("canonicalizes object keys without reordering semantic arrays", () => {
    expect(canonicalSessionCreateJson({ z: 1, a: { y: true, x: null }, ordered: ["b", "a"] })).toBe(
      '{"a":{"x":null,"y":true},"ordered":["b","a"],"z":1}',
    );
    expect(fingerprintSessionCreateRequest({ b: 2, a: 1 })).toBe(
      fingerprintSessionCreateRequest({ a: 1, b: 2 }),
    );
    expect(fingerprintSessionCreateRequest({ ordered: ["a", "b"] })).not.toBe(
      fingerprintSessionCreateRequest({ ordered: ["b", "a"] }),
    );
  });

  test("uses a keyed credential digest and never embeds plaintext", () => {
    const headers = { Authorization: "tiny-secret", "X-Tenant": "example" };
    const first = fingerprintSessionMcpCredentialHeaders(new Uint8Array(32).fill(1), headers);
    const same = fingerprintSessionMcpCredentialHeaders(new Uint8Array(32).fill(1), {
      "X-Tenant": "example",
      Authorization: "tiny-secret",
    });
    const otherKey = fingerprintSessionMcpCredentialHeaders(new Uint8Array(32).fill(2), headers);
    expect(first).toBe(same);
    expect(first).not.toBe(otherKey);
    expect(first).not.toContain("tiny-secret");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects non-JSON and non-finite inputs", () => {
    expect(() => canonicalSessionCreateJson({ value: Number.NaN })).toThrow("non-finite");
    expect(() => canonicalSessionCreateJson({ value: new Date() })).toThrow("plain JSON");
    expect(() => canonicalSessionCreateJson({ value: 1n })).toThrow("unsupported bigint");
  });
});
