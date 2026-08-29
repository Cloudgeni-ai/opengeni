import { describe, expect, test } from "bun:test";

import { createRandomUuid, installRandomUuidCompatibility } from "./crypto-random-uuid";

const deterministicCrypto = {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T {
    if (array instanceof Uint8Array) {
      array.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    }
    return array;
  },
};

describe("crypto.randomUUID compatibility", () => {
  test("creates an RFC 4122 version 4 UUID with secure random bytes", () => {
    expect(createRandomUuid(deterministicCrypto)).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  test("installs an idempotent fallback when randomUUID is unavailable", () => {
    const cryptoSource: typeof deterministicCrypto & { randomUUID?: Crypto["randomUUID"] } = {
      ...deterministicCrypto,
    };
    installRandomUuidCompatibility(cryptoSource);
    const installed = cryptoSource.randomUUID;
    installRandomUuidCompatibility(cryptoSource);

    expect(cryptoSource.randomUUID).toBe(installed);
    expect(cryptoSource.randomUUID!()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  test("preserves a browser-provided randomUUID implementation", () => {
    const nativeRandomUuid = () =>
      "native-uuid" as `${string}-${string}-${string}-${string}-${string}`;
    const cryptoSource = { ...deterministicCrypto, randomUUID: nativeRandomUuid };
    installRandomUuidCompatibility(cryptoSource);

    expect(cryptoSource.randomUUID).toBe(nativeRandomUuid);
  });
});
