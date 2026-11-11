/**
 * Bitwarden client cryptography, from the published protocol (bitwarden/clients
 * `EncString`, `KdfConfig` and `SymmetricCryptoKey`; Vaultwarden implements the
 * same server side). Everything here is node:crypto; nothing is cached.
 *
 * - A symmetric key is 64 bytes: AES-256 encryption key, then HMAC-SHA256 key.
 *   Legacy (type 0) keys are 32 bytes with no MAC key.
 * - An encrypted string is `<type>.<b64>|<b64>|<b64>`:
 *   type 2 is AES-256-CBC with HMAC-SHA256 over iv || ciphertext (`2.iv|ct|mac`),
 *   type 0 is legacy AES-256-CBC without a MAC (`0.iv|ct`),
 *   types 3 and 4 are RSA-2048 OAEP with SHA-256 and SHA-1 (`4.ct`).
 * - The master key is PBKDF2-SHA256 or Argon2id of the master password, salted
 *   with the account email (Argon2id salts with its SHA-256), and is stretched
 *   with HKDF-Expand into a symmetric key that opens the account's user key.
 */
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  pbkdf2,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import * as nodeCrypto from "node:crypto";

export class BitwardenCryptoError extends Error {
  readonly reason: "malformed" | "mac_mismatch" | "wrong_key" | "unsupported";
  constructor(reason: BitwardenCryptoError["reason"], message: string) {
    super(message);
    this.name = "BitwardenCryptoError";
    this.reason = reason;
  }
}

export interface SymmetricKey {
  readonly encKey: Uint8Array;
  /** Null only for legacy 32-byte keys, which decrypt type 0 strings. */
  readonly macKey: Uint8Array | null;
}

export const ENC_AES_CBC_256 = 0;
export const ENC_AES_CBC_256_HMAC = 2;
export const ENC_RSA_OAEP_SHA256 = 3;
export const ENC_RSA_OAEP_SHA1 = 4;

export function symmetricKeyFromBytes(bytes: Uint8Array): SymmetricKey {
  if (bytes.length === 64) {
    return { encKey: bytes.slice(0, 32), macKey: bytes.slice(32, 64) };
  }
  if (bytes.length === 32) return { encKey: bytes.slice(), macKey: null };
  throw new BitwardenCryptoError("malformed", `a symmetric key is 64 bytes, not ${bytes.length}`);
}

export function symmetricKeyBytes(key: SymmetricKey): Uint8Array {
  return key.macKey ? concat(key.encKey, key.macKey) : key.encKey.slice();
}

export function generateSymmetricKey(): SymmetricKey {
  return symmetricKeyFromBytes(new Uint8Array(randomBytes(64)));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

function fromB64(value: string): Uint8Array {
  if (!B64.test(value) || value.length % 4 !== 0) {
    throw new BitwardenCryptoError("malformed", "encrypted value is not base64");
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

export function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export type ParsedEncString =
  | { type: 0; iv: Uint8Array; data: Uint8Array }
  | { type: 2; iv: Uint8Array; data: Uint8Array; mac: Uint8Array }
  | { type: 3 | 4; data: Uint8Array };

/** Parses an encrypted string. Strings written before types existed have no prefix. */
export function parseEncString(value: string): ParsedEncString {
  if (typeof value !== "string" || value.length === 0) {
    throw new BitwardenCryptoError("malformed", "encrypted value is empty");
  }
  const dot = value.indexOf(".");
  let type: number;
  let body: string;
  if (dot > 0 && /^\d+$/.test(value.slice(0, dot))) {
    type = Number(value.slice(0, dot));
    body = value.slice(dot + 1);
  } else {
    body = value;
    type = value.split("|").length === 3 ? ENC_AES_CBC_256_HMAC : ENC_AES_CBC_256;
  }
  const parts = body.split("|");
  if (type === ENC_AES_CBC_256 && parts.length === 2) {
    return { type: 0, iv: fromB64(parts[0]!), data: fromB64(parts[1]!) };
  }
  if (type === ENC_AES_CBC_256_HMAC && parts.length === 3) {
    return { type: 2, iv: fromB64(parts[0]!), data: fromB64(parts[1]!), mac: fromB64(parts[2]!) };
  }
  if ((type === ENC_RSA_OAEP_SHA256 || type === ENC_RSA_OAEP_SHA1) && parts.length >= 1) {
    // Types 5 and 6 appended an HMAC that clients never checked; 3/4 have none.
    return { type, data: fromB64(parts[0]!) };
  }
  if (type === 7) {
    throw new BitwardenCryptoError(
      "unsupported",
      "this account uses Bitwarden's newer XChaCha20 key format, which is not supported yet",
    );
  }
  throw new BitwardenCryptoError("unsupported", `encryption type ${type} is not supported`);
}

function hmac(key: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  const mac = createHmac("sha256", key);
  for (const part of parts) mac.update(part);
  return new Uint8Array(mac.digest());
}

function aesDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    return new Uint8Array(Buffer.concat([decipher.update(data), decipher.final()]));
  } catch {
    throw new BitwardenCryptoError("wrong_key", "the value could not be decrypted with this key");
  }
}

/** Decrypts a symmetric encrypted string. The MAC is checked before decryption. */
export function decryptBytes(value: string | ParsedEncString, key: SymmetricKey): Uint8Array {
  const parsed = typeof value === "string" ? parseEncString(value) : value;
  if (parsed.type === ENC_AES_CBC_256_HMAC) {
    if (!key.macKey) {
      throw new BitwardenCryptoError("wrong_key", "an authenticated value needs a 64-byte key");
    }
    const expected = hmac(key.macKey, parsed.iv, parsed.data);
    if (expected.length !== parsed.mac.length || !timingSafeEqual(expected, parsed.mac)) {
      throw new BitwardenCryptoError("mac_mismatch", "the value was not encrypted with this key");
    }
    return aesDecrypt(key.encKey, parsed.iv, parsed.data);
  }
  if (parsed.type === ENC_AES_CBC_256) {
    if (key.macKey) {
      throw new BitwardenCryptoError("wrong_key", "an unauthenticated value needs a legacy key");
    }
    return aesDecrypt(key.encKey, parsed.iv, parsed.data);
  }
  throw new BitwardenCryptoError("malformed", "expected a symmetric encrypted value");
}

export function decryptString(value: string, key: SymmetricKey): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(decryptBytes(value, key));
}

/** Decrypts a value that may be absent: null and undefined stay null. */
export function decryptOptional(value: unknown, key: SymmetricKey): string | null {
  return typeof value === "string" && value.length > 0 ? decryptString(value, key) : null;
}

/** Always type 2 (AES-256-CBC with HMAC-SHA256) under a 64-byte key. */
export function encryptBytes(plain: Uint8Array, key: SymmetricKey): string {
  if (!key.macKey) {
    throw new BitwardenCryptoError("unsupported", "new values are never written with a legacy key");
  }
  const iv = new Uint8Array(randomBytes(16));
  const cipher = createCipheriv("aes-256-cbc", key.encKey, iv);
  const data = new Uint8Array(Buffer.concat([cipher.update(plain), cipher.final()]));
  const mac = hmac(key.macKey, iv, data);
  return `${ENC_AES_CBC_256_HMAC}.${toB64(iv)}|${toB64(data)}|${toB64(mac)}`;
}

export function encryptString(plain: string, key: SymmetricKey): string {
  return encryptBytes(new TextEncoder().encode(plain), key);
}

/**
 * An attachment body as Bitwarden clients upload it (an EncArrayBuffer):
 * the type byte 2, the 16-byte IV, the 32-byte MAC over IV and data, then
 * the AES-256-CBC data. `decryptAttachment` reads it back.
 */
export function encryptAttachment(plain: Uint8Array, key: SymmetricKey): Uint8Array {
  if (!key.macKey) {
    throw new BitwardenCryptoError("unsupported", "new values are never written with a legacy key");
  }
  const iv = new Uint8Array(randomBytes(16));
  const cipher = createCipheriv("aes-256-cbc", key.encKey, iv);
  const data = new Uint8Array(Buffer.concat([cipher.update(plain), cipher.final()]));
  return concat(new Uint8Array([ENC_AES_CBC_256_HMAC]), iv, hmac(key.macKey, iv, data), data);
}

/** Decrypts an RSA-wrapped value (organization keys) with a PKCS#8 DER private key. */
export function rsaDecrypt(value: string, privateKeyDer: Uint8Array): Uint8Array {
  const parsed = parseEncString(value);
  if (parsed.type !== ENC_RSA_OAEP_SHA1 && parsed.type !== ENC_RSA_OAEP_SHA256) {
    throw new BitwardenCryptoError("malformed", "expected an RSA encrypted value");
  }
  try {
    const key = createPrivateKey({ key: Buffer.from(privateKeyDer), format: "der", type: "pkcs8" });
    return new Uint8Array(
      privateDecrypt(
        {
          key,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: parsed.type === ENC_RSA_OAEP_SHA1 ? "sha1" : "sha256",
        },
        parsed.data,
      ),
    );
  } catch {
    throw new BitwardenCryptoError("wrong_key", "the RSA value could not be decrypted");
  }
}

/** RSA-OAEP-SHA1 (type 4), as Bitwarden clients write organization keys. */
export function rsaEncrypt(plain: Uint8Array, publicKeyDer: Uint8Array): string {
  const key = createPublicKey({ key: Buffer.from(publicKeyDer), format: "der", type: "spki" });
  const data = publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    plain,
  );
  return `${ENC_RSA_OAEP_SHA1}.${toB64(new Uint8Array(data))}`;
}

export type BitwardenKdf =
  | { type: "pbkdf2"; iterations: number }
  | { type: "argon2id"; iterations: number; memoryMiB: number; parallelism: number };

/** Server-reported KDF settings (`kdf`, `kdfIterations`, `kdfMemory`, `kdfParallelism`). */
export function kdfFromServer(input: {
  kdf: unknown;
  kdfIterations: unknown;
  kdfMemory?: unknown;
  kdfParallelism?: unknown;
}): BitwardenKdf {
  const iterations = Number(input.kdfIterations);
  if (input.kdf === 0 || input.kdf === "0") {
    if (!Number.isInteger(iterations) || iterations < 5_000 || iterations > 10_000_000) {
      throw new BitwardenCryptoError("unsupported", "the account's PBKDF2 settings are invalid");
    }
    return { type: "pbkdf2", iterations };
  }
  if (input.kdf === 1 || input.kdf === "1") {
    const memoryMiB = Number(input.kdfMemory);
    const parallelism = Number(input.kdfParallelism);
    if (
      !Number.isInteger(iterations) ||
      iterations < 1 ||
      iterations > 100 ||
      !Number.isInteger(memoryMiB) ||
      memoryMiB < 15 ||
      memoryMiB > 1_024 ||
      !Number.isInteger(parallelism) ||
      parallelism < 1 ||
      parallelism > 16
    ) {
      throw new BitwardenCryptoError("unsupported", "the account's Argon2id settings are invalid");
    }
    return { type: "argon2id", iterations, memoryMiB, parallelism };
  }
  throw new BitwardenCryptoError("unsupported", "the account uses an unknown key derivation");
}

/** The salt is the account email, trimmed and lowercased, as every Bitwarden client does. */
export function normalizeSaltEmail(email: string): string {
  return email.trim().toLowerCase();
}

type Argon2Fn = (
  algorithm: "argon2id",
  parameters: {
    message: Uint8Array;
    nonce: Uint8Array;
    parallelism: number;
    tagLength: number;
    memory: number;
    passes: number;
  },
  callback: (error: Error | null, result: Uint8Array) => void,
) => void;

async function argon2id(
  password: Uint8Array,
  salt: Uint8Array,
  kdf: Extract<BitwardenKdf, { type: "argon2id" }>,
): Promise<Uint8Array> {
  const native = (nodeCrypto as unknown as { argon2?: Argon2Fn }).argon2;
  const parameters = {
    message: password,
    nonce: salt,
    parallelism: kdf.parallelism,
    tagLength: 32,
    memory: kdf.memoryMiB * 1_024,
    passes: kdf.iterations,
  };
  if (typeof native === "function") {
    return new Promise((resolve, reject) =>
      native("argon2id", parameters, (error, result) =>
        error ? reject(error) : resolve(new Uint8Array(result)),
      ),
    );
  }
  const { argon2idAsync } = await import("@noble/hashes/argon2");
  return argon2idAsync(password, salt, {
    t: kdf.iterations,
    m: kdf.memoryMiB * 1_024,
    p: kdf.parallelism,
    dkLen: 32,
  });
}

/** The 32-byte master key. Only setup runs this; it is never stored. */
export async function deriveMasterKey(
  password: string,
  email: string,
  kdf: BitwardenKdf,
): Promise<Uint8Array> {
  const secret = new TextEncoder().encode(password);
  const salt = new TextEncoder().encode(normalizeSaltEmail(email));
  if (kdf.type === "pbkdf2") {
    return new Promise((resolve, reject) =>
      pbkdf2(secret, salt, kdf.iterations, 32, "sha256", (error, key) =>
        error ? reject(error) : resolve(new Uint8Array(key)),
      ),
    );
  }
  const hashedSalt = new Uint8Array(createHash("sha256").update(salt).digest());
  return argon2id(secret, hashedSalt, kdf);
}

/** HKDF-Expand (RFC 5869) with SHA-256 for one 32-byte block, without the extract step. */
function hkdfExpand32(prk: Uint8Array, info: string): Uint8Array {
  return hmac(prk, new TextEncoder().encode(info), new Uint8Array([1]));
}

/** The symmetric key the master key opens the user key with. */
export function stretchMasterKey(masterKey: Uint8Array): SymmetricKey {
  return { encKey: hkdfExpand32(masterKey, "enc"), macKey: hkdfExpand32(masterKey, "mac") };
}

/**
 * Opens the account's 64-byte user key. Type 2 keys use the stretched master
 * key; accounts from before 2019 may still have a type 0 key under the master
 * key itself. A key that opens with a valid MAC but is not a 64-byte key is
 * the newer XChaCha20 (COSE) user key: the password was right, the format is
 * unsupported.
 */
export function decryptUserKey(protectedKey: string, masterKey: Uint8Array): SymmetricKey {
  const parsed = parseEncString(protectedKey);
  const opener =
    parsed.type === ENC_AES_CBC_256
      ? { encKey: masterKey, macKey: null }
      : stretchMasterKey(masterKey);
  let bytes: Uint8Array;
  try {
    bytes = decryptBytes(parsed, opener);
  } catch (error) {
    if (error instanceof BitwardenCryptoError && error.reason !== "unsupported") {
      throw new BitwardenCryptoError("wrong_key", "the master password does not open this account");
    }
    throw error;
  }
  if (parsed.type !== ENC_AES_CBC_256 && bytes.length !== 64) {
    throw new BitwardenCryptoError(
      "unsupported",
      "this account uses Bitwarden's newer XChaCha20 key format, which is not supported yet",
    );
  }
  try {
    return symmetricKeyFromBytes(bytes);
  } catch {
    throw new BitwardenCryptoError("wrong_key", "the master password does not open this account");
  }
}

/** The server-side login hash (`masterPasswordHash`): one PBKDF2 round of the password over the master key. */
export function masterPasswordHash(masterKey: Uint8Array, password: string): Promise<string> {
  return new Promise((resolve, reject) =>
    pbkdf2(masterKey, new TextEncoder().encode(password), 1, 32, "sha256", (error, key) =>
      error ? reject(error) : resolve(key.toString("base64")),
    ),
  );
}

/**
 * Decrypts an attachment body: one type byte (2), a 16-byte IV, a 32-byte
 * MAC, then the AES-256-CBC ciphertext.
 */
export function decryptAttachment(body: Uint8Array, key: SymmetricKey): Uint8Array {
  if (body.length < 1 + 16 + 32 + 16 || body[0] !== ENC_AES_CBC_256_HMAC) {
    throw new BitwardenCryptoError("malformed", "the attachment is not in a supported format");
  }
  return decryptBytes(
    {
      type: 2,
      iv: body.subarray(1, 17),
      mac: body.subarray(17, 49),
      data: body.subarray(49),
    },
    key,
  );
}

/** A new RSA-2048 key pair, as clients create for accounts and organizations (setup tooling). */
export function generateRsaKeyPair(): { publicKeyDer: Uint8Array; privateKeyDer: Uint8Array } {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("rsa", {
    modulusLength: 2_048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return { publicKeyDer: new Uint8Array(publicKey), privateKeyDer: new Uint8Array(privateKey) };
}

export function sha256B64(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64");
}
