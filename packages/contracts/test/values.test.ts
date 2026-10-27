import { describe, expect, test } from "bun:test";

import { errorMessage, isRecord, sha256Hex } from "../src/values";

describe("shared value helpers", () => {
  test("isRecord accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });

  test("errorMessage reads an Error's message or stringifies the value", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(42)).toBe("42");
  });

  test("sha256Hex hashes strings as UTF-8 and bytes as given", async () => {
    const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(await sha256Hex("abc")).toBe(abc);
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(abc);
    const shared = new Uint8Array(new SharedArrayBuffer(3));
    shared.set([0x61, 0x62, 0x63]);
    expect(await sha256Hex(shared)).toBe(abc);
    expect(await sha256Hex("é")).toBe(await sha256Hex(new Uint8Array([0xc3, 0xa9])));
  });
});
