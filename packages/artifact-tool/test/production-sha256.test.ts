import { expect, test } from "bun:test";

import { sha256Bytes } from "../src/production-sha256";

test("synchronous production SHA-256 matches canonical vectors", () => {
  const hex = (bytes: Uint8Array): string =>
    [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  expect(hex(sha256Bytes(new Uint8Array()))).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  expect(hex(sha256Bytes(new TextEncoder().encode("abc")))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
