/**
 * SSH keys for `ssh_key` items: the public key and fingerprint a private key
 * implies, and freshly generated key pairs.
 *
 * A public key is the OpenSSH one-line form ("ssh-ed25519 AAAA… comment");
 * a fingerprint is OpenSSH's default, "SHA256:" and the unpadded base64
 * SHA-256 of the public key blob. Private keys are read in the OpenSSH
 * format (also when passphrase-protected: its public key is stored in the
 * clear) and in unencrypted PEM (PKCS#1, PKCS#8, SEC1). Generated keys are
 * written in the unencrypted OpenSSH format.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

/** The JWK members SSH key encoding reads. */
type Jwk = Partial<Record<"kty" | "crv" | "x" | "y" | "n" | "e" | "d" | "p" | "q" | "qi", string>>;

export type SshKeyAlgorithm = "ed25519" | "rsa4096";

export interface SshPublicKeyInfo {
  /** OpenSSH one-line public key, with the comment when the key has one. */
  publicKey: string;
  fingerprint: string;
  /** The key type, such as "ssh-ed25519" or "ssh-rsa". */
  keyType: string;
}

export interface GeneratedSshKeyPair extends SshPublicKeyInfo {
  privateKey: string;
}

const OPENSSH_MAGIC = Buffer.from("openssh-key-v1\0", "latin1");
const OPENSSH_BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const OPENSSH_END = "-----END OPENSSH PRIVATE KEY-----";

class Reader {
  private offset = 0;
  constructor(private readonly buffer: Buffer) {}
  bytes(): Buffer {
    const length = this.uint32();
    if (this.offset + length > this.buffer.length) throw new Error("truncated");
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  uint32(): number {
    if (this.offset + 4 > this.buffer.length) throw new Error("truncated");
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  raw(length: number): Buffer {
    if (this.offset + length > this.buffer.length) throw new Error("truncated");
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
}

/** An unsigned big-endian integer as an SSH mpint. */
function mpint(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  return sshString(trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function b64url(value: string | undefined): Buffer {
  if (!value) throw new Error("incomplete key");
  return Buffer.from(value, "base64url");
}

const EC_CURVES: Record<string, { name: string; size: number }> = {
  "P-256": { name: "nistp256", size: 32 },
  "P-384": { name: "nistp384", size: 48 },
  "P-521": { name: "nistp521", size: 66 },
};

/** The SSH wire blob of a public key (RFC 4253, RFC 5656, RFC 8709). */
function publicBlob(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" }) as Jwk;
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") {
    return Buffer.concat([sshString("ssh-ed25519"), sshString(b64url(jwk.x))]);
  }
  if (jwk.kty === "RSA") {
    return Buffer.concat([sshString("ssh-rsa"), mpint(b64url(jwk.e)), mpint(b64url(jwk.n))]);
  }
  const curve = jwk.kty === "EC" && jwk.crv ? EC_CURVES[jwk.crv] : undefined;
  if (curve) {
    const pad = (value: Buffer) =>
      Buffer.concat([Buffer.alloc(Math.max(0, curve.size - value.length)), value]);
    const point = Buffer.concat([Buffer.from([4]), pad(b64url(jwk.x)), pad(b64url(jwk.y))]);
    return Buffer.concat([
      sshString(`ecdsa-sha2-${curve.name}`),
      sshString(curve.name),
      sshString(point),
    ]);
  }
  throw new Error("unsupported key type");
}

function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

function infoFromBlob(blob: Buffer, comment: string): SshPublicKeyInfo {
  const keyType = new Reader(blob).bytes().toString("latin1");
  const base = `${keyType} ${blob.toString("base64")}`;
  const cleanComment = comment.replace(/[\r\n]+/g, " ").trim();
  return {
    publicKey: cleanComment ? `${base} ${cleanComment}` : base,
    fingerprint: fingerprintOf(blob),
    keyType,
  };
}

function opensshBody(text: string): Buffer | null {
  const start = text.indexOf(OPENSSH_BEGIN);
  const end = text.indexOf(OPENSSH_END);
  if (start < 0 || end < start) return null;
  const body = Buffer.from(
    text.slice(start + OPENSSH_BEGIN.length, end).replace(/\s+/g, ""),
    "base64",
  );
  return body.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC) ? body : null;
}

function opensshInfo(body: Buffer): SshPublicKeyInfo {
  const reader = new Reader(body);
  reader.raw(OPENSSH_MAGIC.length);
  const cipher = reader.bytes().toString("latin1");
  reader.bytes(); // kdf name
  reader.bytes(); // kdf options
  if (reader.uint32() < 1) throw new Error("no key");
  const blob = reader.bytes();
  let comment = "";
  if (cipher === "none") {
    // The private section ends with the comment; read it when unencrypted.
    try {
      const section = new Reader(reader.bytes());
      if (section.uint32() === section.uint32()) {
        const type = section.bytes().toString("latin1");
        const parts =
          type === "ssh-ed25519" ? 2 : type === "ssh-rsa" ? 6 : type.startsWith("ecdsa") ? 3 : 0;
        for (let index = 0; index < parts; index += 1) section.bytes();
        if (parts > 0) comment = section.bytes().toString("utf8");
      }
    } catch {
      comment = "";
    }
  }
  return infoFromBlob(blob, comment);
}

/**
 * The public key and fingerprint of a private key, or null when the text is
 * no private key Opengeni can read (for example a passphrase-protected PEM
 * key, whose public key is encrypted too).
 */
export function sshPublicKeyFromPrivateKey(privateKey: string): SshPublicKeyInfo | null {
  const text = privateKey.trim();
  try {
    const body = opensshBody(text);
    if (body) return opensshInfo(body);
    if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) return null;
    return infoFromBlob(publicBlob(createPublicKey(createPrivateKey(text))), "");
  } catch {
    return null;
  }
}

/** The fingerprint of an OpenSSH one-line public key, or null when it is none. */
export function sshPublicKeyFingerprint(publicKey: string): string | null {
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1]!)) return null;
  const blob = Buffer.from(parts[1]!, "base64");
  try {
    return new Reader(blob).bytes().toString("latin1") === parts[0] ? fingerprintOf(blob) : null;
  } catch {
    return null;
  }
}

/** True when the text holds an OpenSSH or PEM private key block. */
export function looksLikeSshPrivateKey(value: string): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value);
}

function wrap(base64: string): string {
  return base64.match(/.{1,70}/g)!.join("\n");
}

function opensshPrivateKey(blob: Buffer, privateParts: Buffer[], comment: string): string {
  const check = randomBytes(4).readUInt32BE(0);
  const keyType = new Reader(blob).bytes();
  let section = Buffer.concat([
    uint32(check),
    uint32(check),
    sshString(keyType),
    ...privateParts,
    sshString(comment),
  ]);
  const padding: number[] = [];
  for (let index = 1; (section.length + padding.length) % 8 !== 0; index += 1) padding.push(index);
  section = Buffer.concat([section, Buffer.from(padding)]);
  const body = Buffer.concat([
    OPENSSH_MAGIC,
    sshString("none"),
    sshString("none"),
    sshString(""),
    uint32(1),
    sshString(blob),
    sshString(section),
  ]);
  return `${OPENSSH_BEGIN}\n${wrap(body.toString("base64"))}\n${OPENSSH_END}\n`;
}

/**
 * A new key pair. The private key is unencrypted OpenSSH text, ready for
 * `ssh -i`, an SSH agent or a provider that stores SSH keys.
 */
export function generateSshKeyPair(
  algorithm: SshKeyAlgorithm = "ed25519",
  comment = "",
): GeneratedSshKeyPair {
  if (algorithm === "ed25519") {
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" }) as Jwk;
    const seed = b64url(jwk.d);
    const pub = b64url(jwk.x);
    const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);
    const text = opensshPrivateKey(
      blob,
      [sshString(pub), sshString(Buffer.concat([seed, pub]))],
      comment,
    );
    return { privateKey: text, ...infoFromBlob(blob, comment) };
  }
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 4096, publicExponent: 65537 });
  const jwk = privateKey.export({ format: "jwk" }) as Jwk;
  const blob = Buffer.concat([sshString("ssh-rsa"), mpint(b64url(jwk.e)), mpint(b64url(jwk.n))]);
  const text = opensshPrivateKey(
    blob,
    [
      mpint(b64url(jwk.n)),
      mpint(b64url(jwk.e)),
      mpint(b64url(jwk.d)),
      mpint(b64url(jwk.qi)),
      mpint(b64url(jwk.p)),
      mpint(b64url(jwk.q)),
    ],
    comment,
  );
  return { privateKey: text, ...infoFromBlob(blob, comment) };
}
