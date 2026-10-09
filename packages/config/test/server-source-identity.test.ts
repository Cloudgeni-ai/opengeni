import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { constants } from "node:fs";

const original = await import("node:fs/promises");
const originalOpen = original.open;
let bytes: Buffer;
let attributes: {
  uid: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile(): boolean;
};
let changed: boolean;
let unavailable: boolean;
let closes: number;
let opens: Array<{ path: unknown; flags: unknown }>;
mock.module("node:fs/promises", () => ({
  ...original,
  open: async (path: unknown, flags: unknown) => {
    opens.push({ path, flags });
    if (unavailable) throw new Error("source unavailable");
    let observed = 0;
    return {
      stat: async () => ({
        ...attributes,
        mtimeMs: changed && observed++ > 0 ? 1 : attributes.mtimeMs,
      }),
      read: async (buffer: Buffer) => ({ bytesRead: bytes.copy(buffer) }),
      close: async () => {
        closes++;
      },
    };
  },
}));
const { readImmutableServerSourceSha } = await import("../src/server-source-identity");
afterAll(() => {
  mock.module("node:fs/promises", () => ({ ...original, open: originalOpen }));
});
beforeEach(() => {
  bytes = Buffer.from("a".repeat(40));
  attributes = { uid: 0, mode: 0o100444, size: 40, mtimeMs: 0, ctimeMs: 0, isFile: () => true };
  changed = false;
  unavailable = false;
  closes = 0;
  opens = [];
});

test("qualifies baked root-owned bytes and closes its independently opened handle", async () => {
  expect(await readImmutableServerSourceSha()).toBe("a".repeat(40));
  expect(opens).toEqual([
    { path: "/opt/opengeni/source-sha", flags: constants.O_RDONLY | constants.O_NOFOLLOW },
  ]);
  expect(closes).toBe(1);
});

test("rejects a writable, foreign-owned or nonregular source without reading replacement settings", async () => {
  for (const change of [{ uid: 1000 }, { mode: 0o100644 }, { isFile: () => false }]) {
    const saved = attributes;
    attributes = { ...saved, ...change };
    expect(await readImmutableServerSourceSha()).toBeUndefined();
    attributes = saved;
  }
  expect(closes).toBe(3);
});

test("rejects malformed bytes, including non-ASCII bytes that could alias hexadecimal in ASCII decoding", async () => {
  for (const content of [
    Buffer.from("A".repeat(40)),
    Buffer.from("g".repeat(40)),
    Buffer.alloc(40, 0xe1),
    Buffer.from("development"),
    Buffer.from("a".repeat(40) + "\n"),
  ]) {
    bytes = content;
    attributes.size = content.length;
    expect(await readImmutableServerSourceSha()).toBeUndefined();
  }
  expect(closes).toBe(5);
});

test("a source change during observation rejects qualification", async () => {
  changed = true;
  expect(await readImmutableServerSourceSha()).toBeUndefined();
  expect(closes).toBe(1);
});

test("missing or symlink-rejected baked source never falls back to deployment environment", async () => {
  unavailable = true;
  const prior = process.env.OPENGENI_SOURCE_SHA;
  process.env.OPENGENI_SOURCE_SHA = "b".repeat(40);
  try {
    expect(await readImmutableServerSourceSha()).toBeUndefined();
  } finally {
    if (prior === undefined) delete process.env.OPENGENI_SOURCE_SHA;
    else process.env.OPENGENI_SOURCE_SHA = prior;
  }
  expect(closes).toBe(0);
});
