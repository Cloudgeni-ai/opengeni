type CryptoUuidSource = Pick<Crypto, "getRandomValues"> & {
  randomUUID?: Crypto["randomUUID"];
};

/**
 * Keep the core app usable on private HTTP origins where browsers expose
 * getRandomValues but withhold the secure-context-only randomUUID helper.
 * This does not make other secure-context-only features available.
 */
export function createRandomUuid(cryptoSource: Pick<Crypto, "getRandomValues">): string {
  const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

export function installRandomUuidCompatibility(cryptoSource: CryptoUuidSource): void {
  if (typeof cryptoSource.randomUUID === "function") return;

  Object.defineProperty(cryptoSource, "randomUUID", {
    configurable: true,
    value: () => createRandomUuid(cryptoSource),
  });
}

if (typeof globalThis.crypto !== "undefined") {
  installRandomUuidCompatibility(globalThis.crypto);
}
