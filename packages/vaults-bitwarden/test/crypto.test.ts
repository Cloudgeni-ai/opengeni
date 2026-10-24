import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { argon2idAsync } from "@noble/hashes/argon2";
import { sha256 } from "@noble/hashes/sha2";
import {
  BitwardenCryptoError,
  decryptAttachment,
  decryptString,
  decryptUserKey,
  deriveMasterKey,
  encryptBytes,
  encryptString,
  generateRsaKeyPair,
  generateSymmetricKey,
  kdfFromServer,
  parseEncString,
  rsaDecrypt,
  rsaEncrypt,
  stretchMasterKey,
  symmetricKeyBytes,
  symmetricKeyFromBytes,
  toB64,
} from "../src/crypto";

function reason(run: () => unknown): BitwardenCryptoError["reason"] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BitwardenCryptoError);
    return (error as BitwardenCryptoError).reason;
  }
  throw new Error("expected a BitwardenCryptoError");
}

describe("encrypted strings", () => {
  test("round-trip as type 2 and refuse another key or a changed byte", () => {
    const key = generateSymmetricKey();
    const sealed = encryptString("hunter2 ✓", key);
    expect(sealed).toMatch(/^2\.[^|]+\|[^|]+\|[^|]+$/);
    expect(decryptString(sealed, key)).toBe("hunter2 ✓");
    expect(reason(() => decryptString(sealed, generateSymmetricKey()))).toBe("mac_mismatch");
    const [prefix, iv, data, mac] = sealed.split(/[.|]/) as [string, string, string, string];
    const flipped = Buffer.from(data, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(
      reason(() => decryptString(`${prefix}.${iv}|${flipped.toString("base64")}|${mac}`, key)),
    ).toBe("mac_mismatch");
  });

  test("reads legacy type 0 values under a 32-byte key, and never writes them", () => {
    const legacy = symmetricKeyFromBytes(new Uint8Array(randomBytes(32)));
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", legacy.encKey, iv);
    const data = Buffer.concat([cipher.update("old secret"), cipher.final()]);
    const value = `0.${iv.toString("base64")}|${data.toString("base64")}`;
    expect(decryptString(value, legacy)).toBe("old secret");
    // Values from before typed strings had no prefix at all.
    expect(decryptString(value.slice(2), legacy)).toBe("old secret");
    expect(reason(() => decryptString(value, generateSymmetricKey()))).toBe("wrong_key");
    expect(reason(() => encryptString("new", legacy))).toBe("unsupported");
  });

  test("names unsupported and malformed formats", () => {
    expect(reason(() => parseEncString("7.AAAA"))).toBe("unsupported");
    expect(reason(() => parseEncString("9.AAAA|AAAA"))).toBe("unsupported");
    expect(reason(() => parseEncString("2.not base64!|AAAA|AAAA"))).toBe("malformed");
    expect(reason(() => parseEncString(""))).toBe("malformed");
    expect(reason(() => symmetricKeyFromBytes(new Uint8Array(48)))).toBe("malformed");
  });

  test("RSA-wrapped keys open with the matching private key only", () => {
    const { publicKeyDer, privateKeyDer } = generateRsaKeyPair();
    const orgKey = symmetricKeyBytes(generateSymmetricKey());
    const wrapped = rsaEncrypt(orgKey, publicKeyDer);
    expect(wrapped.startsWith("4.")).toBe(true);
    expect(rsaDecrypt(wrapped, privateKeyDer)).toEqual(orgKey);
    expect(reason(() => rsaDecrypt(wrapped, generateRsaKeyPair().privateKeyDer))).toBe("wrong_key");
    expect(
      reason(() => rsaDecrypt(encryptString("x", generateSymmetricKey()), privateKeyDer)),
    ).toBe("malformed");
  });

  test("attachments decrypt from their binary layout and refuse a changed byte", () => {
    const key = generateSymmetricKey();
    const plain = new Uint8Array(randomBytes(100));
    const [, iv, data, mac] = encryptBytes(plain, key).split(/[.|]/) as [
      string,
      string,
      string,
      string,
    ];
    const body = new Uint8Array(
      Buffer.concat([
        Buffer.from([2]),
        Buffer.from(iv, "base64"),
        Buffer.from(mac, "base64"),
        Buffer.from(data, "base64"),
      ]),
    );
    expect(decryptAttachment(body, key)).toEqual(plain);
    const changed = body.slice();
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    expect(reason(() => decryptAttachment(changed, key))).toBe("mac_mismatch");
    expect(reason(() => decryptAttachment(body.subarray(0, 40), key))).toBe("malformed");
  });
});

describe("account keys", () => {
  test("the master key opens the user key; another password does not", async () => {
    const kdf = { type: "pbkdf2" as const, iterations: 5_000 };
    const masterKey = await deriveMasterKey("correct horse", "  Someone@Example.TEST ", kdf);
    // The salt is the trimmed, lowercased email.
    expect(await deriveMasterKey("correct horse", "someone@example.test", kdf)).toEqual(masterKey);
    const userKey = generateSymmetricKey();
    const protectedKey = encryptBytes(symmetricKeyBytes(userKey), stretchMasterKey(masterKey));
    expect(symmetricKeyBytes(decryptUserKey(protectedKey, masterKey))).toEqual(
      symmetricKeyBytes(userKey),
    );
    const other = await deriveMasterKey("wrong horse", "someone@example.test", kdf);
    expect(reason(() => decryptUserKey(protectedKey, other))).toBe("wrong_key");
  });

  test("opens a pre-2019 type 0 user key directly under the master key", async () => {
    const masterKey = await deriveMasterKey("pw", "a@example.test", {
      type: "pbkdf2",
      iterations: 5_000,
    });
    const userKey = new Uint8Array(randomBytes(64));
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", masterKey, iv);
    const data = Buffer.concat([cipher.update(userKey), cipher.final()]);
    const protectedKey = `0.${iv.toString("base64")}|${data.toString("base64")}`;
    expect(symmetricKeyBytes(decryptUserKey(protectedKey, masterKey))).toEqual(userKey);
  });

  test("Argon2id hashes the salt first, as Bitwarden clients do", async () => {
    const kdf = { type: "argon2id" as const, iterations: 1, memoryMiB: 16, parallelism: 1 };
    const derived = await deriveMasterKey("pw", "A@example.test", kdf);
    const expected = await argon2idAsync(
      new TextEncoder().encode("pw"),
      sha256(new TextEncoder().encode("a@example.test")),
      {
        t: 1,
        m: 16 * 1_024,
        p: 1,
        dkLen: 32,
      },
    );
    expect(toB64(derived)).toBe(toB64(expected));
  });

  test("validates the server's key derivation settings", () => {
    expect(kdfFromServer({ kdf: 0, kdfIterations: 600_000 })).toEqual({
      type: "pbkdf2",
      iterations: 600_000,
    });
    expect(kdfFromServer({ kdf: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4 })).toEqual({
      type: "argon2id",
      iterations: 3,
      memoryMiB: 64,
      parallelism: 4,
    });
    expect(reason(() => kdfFromServer({ kdf: 0, kdfIterations: 4_999 }))).toBe("unsupported");
    expect(
      reason(() =>
        kdfFromServer({ kdf: 1, kdfIterations: 3, kdfMemory: 4_096, kdfParallelism: 4 }),
      ),
    ).toBe("unsupported");
    expect(reason(() => kdfFromServer({ kdf: 2, kdfIterations: 1 }))).toBe("unsupported");
  });
});
