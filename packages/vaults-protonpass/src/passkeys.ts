import { createPrivateKey } from "node:crypto";
import type { ProviderPasskey, ProviderPasskeyMeta } from "./contract";
import type { ProtonPasskey } from "./schema";

/**
 * Proton Pass keeps a login's passkey as `content`: MessagePack of
 * `{ c: <inner MessagePack>, v: 1 }`, whose inner document is the passkey with
 * its COSE key (`key.par` holds label/value pairs, EC2: -1 curve, -2 x,
 * -3 y, -4 d). Byte strings may be MessagePack bin or arrays of integers.
 */

type Packed = null | boolean | number | bigint | string | Uint8Array | Packed[] | PackedMap;
type PackedMap = Map<Packed, Packed>;

class PackReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  done(): boolean {
    return this.offset === this.bytes.length;
  }

  private take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) throw new Error("truncated MessagePack");
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  private uint(size: 1 | 2 | 4 | 8): number | bigint {
    const at = this.offset;
    this.take(size);
    if (size === 1) return this.view.getUint8(at);
    if (size === 2) return this.view.getUint16(at);
    if (size === 4) return this.view.getUint32(at);
    const value = this.view.getBigUint64(at);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  }

  private int(size: 1 | 2 | 4 | 8): number | bigint {
    const at = this.offset;
    this.take(size);
    if (size === 1) return this.view.getInt8(at);
    if (size === 2) return this.view.getInt16(at);
    if (size === 4) return this.view.getInt32(at);
    const value = this.view.getBigInt64(at);
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  }

  private length(size: 1 | 2 | 4): number {
    return Number(this.uint(size));
  }

  private string(length: number): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.take(length));
  }

  private array(length: number, depth: number): Packed[] {
    const items: Packed[] = [];
    for (let index = 0; index < length; index += 1) items.push(this.read(depth + 1));
    return items;
  }

  private map(length: number, depth: number): PackedMap {
    const entries: PackedMap = new Map();
    for (let index = 0; index < length; index += 1) {
      const key = this.read(depth + 1);
      entries.set(key, this.read(depth + 1));
    }
    return entries;
  }

  read(depth = 0): Packed {
    if (depth > 32) throw new Error("MessagePack nests too deeply");
    const type = this.take(1)[0]!;
    if (type <= 0x7f) return type;
    if (type >= 0xe0) return type - 0x100;
    if (type >= 0x80 && type <= 0x8f) return this.map(type & 0x0f, depth);
    if (type >= 0x90 && type <= 0x9f) return this.array(type & 0x0f, depth);
    if (type >= 0xa0 && type <= 0xbf) return this.string(type & 0x1f);
    switch (type) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return this.take(this.length(1)).slice();
      case 0xc5:
        return this.take(this.length(2)).slice();
      case 0xc6:
        return this.take(this.length(4)).slice();
      case 0xca: {
        const at = this.offset;
        this.take(4);
        return this.view.getFloat32(at);
      }
      case 0xcb: {
        const at = this.offset;
        this.take(8);
        return this.view.getFloat64(at);
      }
      case 0xcc:
        return this.uint(1);
      case 0xcd:
        return this.uint(2);
      case 0xce:
        return this.uint(4);
      case 0xcf:
        return this.uint(8);
      case 0xd0:
        return this.int(1);
      case 0xd1:
        return this.int(2);
      case 0xd2:
        return this.int(4);
      case 0xd3:
        return this.int(8);
      case 0xd9:
        return this.string(this.length(1));
      case 0xda:
        return this.string(this.length(2));
      case 0xdb:
        return this.string(this.length(4));
      case 0xdc:
        return this.array(this.length(2), depth);
      case 0xdd:
        return this.array(this.length(4), depth);
      case 0xde:
        return this.map(this.length(2), depth);
      case 0xdf:
        return this.map(this.length(4), depth);
      default:
        throw new Error(`unsupported MessagePack type 0x${type.toString(16)}`);
    }
  }
}

function unpack(bytes: Uint8Array): Packed {
  const reader = new PackReader(bytes);
  const value = reader.read();
  if (!reader.done()) throw new Error("trailing MessagePack bytes");
  return value;
}

function field(value: Packed, name: string): Packed | undefined {
  return value instanceof Map ? value.get(name) : undefined;
}

/** A byte string written as MessagePack bin or as an array of byte values. */
function bytesOf(value: Packed | undefined): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (!Array.isArray(value)) return null;
  const bytes = new Uint8Array(value.length);
  for (const [index, byte] of value.entries()) {
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    bytes[index] = byte;
  }
  return bytes;
}

function textOf(value: Packed | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** An adjacently tagged value `{ t, c }`, as Proton writes COSE labels and values. */
function tagged(value: Packed | undefined): { t: string; c: Packed | undefined } | null {
  const tag = field(value ?? null, "t");
  return typeof tag === "string" ? { t: tag, c: field(value ?? null, "c") } : null;
}

/** A COSE integer label or value; Proton writes integer values as i128 little-endian bytes. */
function integerOf(value: Packed | undefined): number | null {
  const entry = tagged(value);
  if (!entry || entry.t !== "int") return null;
  if (typeof entry.c === "number") return entry.c;
  const inner = bytesOf(field(entry.c ?? null, "inner"));
  if (!inner) return null;
  let result = 0n;
  for (let index = inner.length - 1; index >= 0; index -= 1) {
    result = (result << 8n) | BigInt(inner[index]!);
  }
  if (inner.length > 0 && inner[inner.length - 1]! & 0x80) result -= 1n << BigInt(inner.length * 8);
  return result >= BigInt(Number.MIN_SAFE_INTEGER) && result <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(result)
    : null;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** The PKCS#8 private key of a COSE EC2 P-256 key, or null for any other kind. */
function privateKeyOf(key: Packed | undefined): string | null {
  const kty = tagged(field(key ?? null, "kty"));
  if (!kty || !(kty.c === "EC2" || kty.c === 2)) return null;
  const params = field(key ?? null, "par");
  if (!Array.isArray(params)) return null;
  const byLabel = new Map<number, Packed | undefined>();
  for (const pair of params) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const label = integerOf(pair[0]);
    if (label !== null) byLabel.set(label, pair[1]);
  }
  const parameter = (label: number) => {
    const entry = tagged(byLabel.get(label));
    return entry?.t === "bytes" ? bytesOf(entry.c) : null;
  };
  if (integerOf(byLabel.get(-1)) !== 1) return null; // P-256
  const x = parameter(-2);
  const y = parameter(-3);
  const d = parameter(-4);
  if (!x || !y || !d || x.length !== 32 || y.length !== 32 || d.length !== 32) return null;
  const der = createPrivateKey({
    key: { kty: "EC", crv: "P-256", x: base64url(x), y: base64url(y), d: base64url(d) },
    format: "jwk",
  }).export({ format: "der", type: "pkcs8" });
  return base64url(new Uint8Array(der));
}

function credentialIdOf(passkey: ProtonPasskey): string | null {
  return passkey.credential_id.length > 0
    ? base64url(Uint8Array.from(passkey.credential_id))
    : null;
}

/** A login passkey's display metadata, without opening its key. */
export function protonPasskeyMeta(passkey: ProtonPasskey): ProviderPasskeyMeta | null {
  const credentialId = credentialIdOf(passkey);
  if (!credentialId || !passkey.rp_id) return null;
  return { credentialId, rpId: passkey.rp_id, userName: passkey.user_name || null };
}

/**
 * A login passkey with its key material, or null when its content is not a
 * format-1 ES256 P-256 passkey. Proton's counter is reported when kept.
 */
export function decodeProtonPasskey(passkey: ProtonPasskey): ProviderPasskey | null {
  const meta = protonPasskeyMeta(passkey);
  if (!meta || passkey.content.length === 0) return null;
  try {
    const outer = unpack(Uint8Array.from(passkey.content));
    if (field(outer, "v") !== 1) return null;
    const inner = bytesOf(field(outer, "c"));
    if (!inner) return null;
    const document = unpack(inner);
    const privateKey = privateKeyOf(field(document, "key"));
    if (!privateKey) return null;
    const counter = field(document, "cnt");
    const userHandle =
      bytesOf(field(document, "uhd")) ??
      (passkey.user_handle.length > 0 ? Uint8Array.from(passkey.user_handle) : null);
    return {
      credentialId: meta.credentialId,
      rpId: meta.rpId,
      userHandle: userHandle && userHandle.length > 0 ? base64url(userHandle) : null,
      userName: textOf(field(document, "un")) ?? (passkey.user_name || null),
      userDisplayName: textOf(field(document, "udn")) ?? (passkey.user_display_name || null),
      privateKey,
      signCount: typeof counter === "number" && Number.isSafeInteger(counter) ? counter : 0,
    };
  } catch {
    return null;
  }
}
