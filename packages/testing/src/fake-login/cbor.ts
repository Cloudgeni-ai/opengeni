/**
 * Minimal CBOR (RFC 8949) decoder for WebAuthn attestation objects and COSE
 * keys: unsigned/negative integers, byte and text strings, arrays, maps, simple
 * values and floats. Indefinite lengths and tags are rejected (WebAuthn uses the
 * canonical CTAP2 encoding, which never needs them).
 */
export type CborValue =
  | number
  | bigint
  | Uint8Array
  | string
  | boolean
  | null
  | undefined
  | CborValue[]
  | Map<CborValue, CborValue>;

export function decodeCbor(bytes: Uint8Array): CborValue {
  const { value, offset } = decodeCborPrefix(bytes, 0);
  if (offset !== bytes.length) throw new Error(`trailing CBOR bytes at ${offset}`);
  return value;
}

/** Decodes one item and returns where it ended (authData embeds a COSE key followed by extensions). */
export function decodeCborPrefix(
  bytes: Uint8Array,
  start: number,
): { value: CborValue; offset: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;

  const readLength = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return view.getUint8(offset++);
    if (info === 25) {
      const value = view.getUint16(offset);
      offset += 2;
      return value;
    }
    if (info === 26) {
      const value = view.getUint32(offset);
      offset += 4;
      return value;
    }
    if (info === 27) {
      const value = view.getBigUint64(offset);
      offset += 8;
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR length too large");
      return Number(value);
    }
    throw new Error(`unsupported CBOR additional info ${info}`);
  };

  const item = (): CborValue => {
    if (offset >= bytes.length) throw new Error("truncated CBOR");
    const initial = view.getUint8(offset++);
    const major = initial >> 5;
    const info = initial & 0x1f;
    switch (major) {
      case 0:
        return readLength(info);
      case 1:
        return -1 - readLength(info);
      case 2: {
        const length = readLength(info);
        const value = bytes.slice(offset, offset + length);
        if (value.length !== length) throw new Error("truncated CBOR byte string");
        offset += length;
        return value;
      }
      case 3: {
        const length = readLength(info);
        const value = new TextDecoder().decode(bytes.slice(offset, offset + length));
        offset += length;
        return value;
      }
      case 4: {
        const length = readLength(info);
        const out: CborValue[] = [];
        for (let index = 0; index < length; index += 1) out.push(item());
        return out;
      }
      case 5: {
        const length = readLength(info);
        const out = new Map<CborValue, CborValue>();
        for (let index = 0; index < length; index += 1) {
          const key = item();
          out.set(key, item());
        }
        return out;
      }
      case 7: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 26) {
          const value = view.getFloat32(offset);
          offset += 4;
          return value;
        }
        if (info === 27) {
          const value = view.getFloat64(offset);
          offset += 8;
          return value;
        }
        throw new Error(`unsupported CBOR simple value ${info}`);
      }
      default:
        throw new Error(`unsupported CBOR major type ${major}`);
    }
  };

  const value = item();
  return { value, offset };
}
