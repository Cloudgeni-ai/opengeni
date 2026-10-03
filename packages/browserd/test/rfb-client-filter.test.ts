import { describe, expect, test } from "bun:test";
import { RfbClientFilter, RfbClientPermissionError } from "../src/rfb-client-filter";

const version = new TextEncoder().encode("RFB 003.008\n");
const hello = new Uint8Array([...version, 1, 1]);
const frameRequest = Uint8Array.of(3, 1, 0, 0, 0, 0, 0, 20, 0, 10);
const key = Uint8Array.of(4, 1, 0, 0, 0, 0, 0, 65);

describe("RFB client permission boundary", () => {
  test("keeps fragmented handshake and pixel negotiation usable without input authority", () => {
    const wire = new Uint8Array([
      ...hello,
      0,
      ...new Uint8Array(19),
      2,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      ...frameRequest,
      150,
      1,
      0,
      0,
      0,
      0,
      0,
      20,
      0,
      10,
      248,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      2,
      65,
      66,
    ]);
    const filter = new RfbClientFilter(false);
    const forwarded = [...wire].flatMap((byte) => filter.accept(Uint8Array.of(byte)));
    expect(new Uint8Array(forwarded.flatMap((message) => [...message]))).toEqual(wire);
  });

  test("refuses key, pointer and extended key messages on view grants", () => {
    for (const message of [key, Uint8Array.of(5, 0, 0, 0, 0, 0), Uint8Array.of(255, 0)]) {
      const filter = new RfbClientFilter(false);
      filter.accept(hello);
      expect(() => filter.accept(message)).toThrow(RfbClientPermissionError);
    }
  });

  test("initializes a shared viewer even when the client requests exclusive access", () => {
    for (const protocolVersion of ["RFB 003.003\n", "RFB 003.008\n"]) {
      const filter = new RfbClientFilter(false);
      filter.accept(new TextEncoder().encode(protocolVersion));
      if (protocolVersion === "RFB 003.008\n") filter.accept(Uint8Array.of(1));
      expect(filter.accept(Uint8Array.of(0))).toEqual([Uint8Array.of(1)]);
    }
  });

  test("permits exact key and pointer messages for input-scoped grants", () => {
    const filter = new RfbClientFilter(true);
    filter.accept(hello);
    const messages = [
      key,
      Uint8Array.of(5, 1, 0, 5, 0, 8),
      Uint8Array.of(255, 0, ...new Uint8Array(10)),
    ];
    for (const message of messages) expect(filter.accept(message)).toEqual([message]);
  });

  test("never grants clipboard, power, display resize or unknown extensions through RFB", () => {
    for (const type of [6, 250, 251, 249, 252]) {
      const filter = new RfbClientFilter(true);
      filter.accept(hello);
      expect(() => filter.accept(Uint8Array.of(type))).toThrow(RfbClientPermissionError);
    }
    const filter = new RfbClientFilter(true);
    filter.accept(hello);
    expect(() => filter.accept(Uint8Array.of(255, 1))).toThrow(RfbClientPermissionError);
    expect(() => filter.accept(Uint8Array.of(5, 0x80))).toThrow(RfbClientPermissionError);
  });

  test("does not advertise automatic clipboard or ungranted control extensions to the server", () => {
    const offered = [0, 7, -223 >>> 0, 0xc0a1e5ce, -309 >>> 0, -308 >>> 0, -316 >>> 0];
    const encodings = new Uint8Array(4 + offered.length * 4);
    encodings[0] = 2;
    const view = new DataView(encodings.buffer);
    view.setUint16(2, offered.length);
    for (let index = 0; index < offered.length; index += 1)
      view.setUint32(4 + index * 4, offered[index]!);
    for (const inputAllowed of [false, true]) {
      const filter = new RfbClientFilter(inputAllowed);
      filter.accept(hello);
      const forwarded = [...encodings].flatMap((byte) => filter.accept(Uint8Array.of(byte)));
      expect(forwarded).toHaveLength(1);
      const sanitized = new DataView(forwarded[0]!.buffer);
      expect(sanitized.getUint16(2)).toBe(3);
      expect([4, 8, 12].map((offset) => sanitized.getUint32(offset))).toEqual(offered.slice(0, 3));
    }
  });

  test("does not reinterpret fragmented mutation bytes as another message", () => {
    const filter = new RfbClientFilter(true);
    filter.accept(hello);
    expect(filter.accept(key.subarray(0, 3))).toEqual([]);
    expect(filter.accept(new Uint8Array([...key.subarray(3), ...frameRequest]))).toEqual([
      key,
      frameRequest,
    ]);
  });

  test("bounds handshake, encodings, fences and buffered messages", () => {
    expect(() =>
      new RfbClientFilter(false).accept(new TextEncoder().encode("RFB 004.008\n")),
    ).toThrow();
    const security = new RfbClientFilter(false);
    security.accept(version);
    expect(() => security.accept(Uint8Array.of(2))).toThrow();
    const encodings = new RfbClientFilter(false);
    encodings.accept(hello);
    expect(() => encodings.accept(Uint8Array.of(2, 0, 0xff, 0xff))).toThrow();
    const fence = new RfbClientFilter(false);
    fence.accept(hello);
    expect(() => fence.accept(Uint8Array.of(248, 0, 0, 0, 0, 0, 0, 0, 65))).toThrow();
    expect(() => new RfbClientFilter(false).accept(new Uint8Array(1024 * 1024 + 1))).toThrow();
  });
});
