import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { digestCanonicalJson } from "../src/catalog";

// Exact previous algorithm: this guards digests already retained in storage.
function previousValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(previousValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, previousValue(entry)]),
    );
  }
  return value;
}
function previousDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(previousValue(value)), "utf8")
    .digest("hex");
}

test("canonical digests preserve stored bytes for nested, unusual and sparse values", () => {
  const symbol = Symbol("ignored");
  const nullPrototype = Object.assign(Object.create(null), { b: 1, a: 2 });
  const sparse = new Array(5);
  sparse[3] = { z: -0, a: NaN };
  const values = [
    null,
    false,
    true,
    0,
    -0,
    NaN,
    Infinity,
    "",
    "é😀\ud800\u0000",
    {},
    [],
    sparse,
    nullPrototype,
    JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"prototype":2}'),
    { "10": "ten", "2": "two", "01": "one", ä: 1, A: 2, z: 3 },
    { a: undefined, b: symbol, c: () => 1, [symbol]: "ignored" },
    [undefined, symbol, () => 1],
    new Date(0),
    new Map([["a", 1]]),
    new Set([1]),
    new Uint8Array([1, 2, 3]),
    /test/i,
    {
      toJSON() {
        return { z: 2, a: this.a };
      },
      a: 1,
    },
  ];
  for (const value of values) expect(digestCanonicalJson(value)).toBe(previousDigest(value));

  let seed = 71439;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const make = (depth: number): unknown => {
    if (!depth || random() < 0.3)
      return [null, false, "😀", random(), undefined][Math.floor(random() * 5)];
    if (random() < 0.35) return Array.from({ length: 5 }, () => make(depth - 1));
    return Object.fromEntries(
      Array.from({ length: 7 }, (_, n) => [
        ["__proto__", "2", "z", "A", "ä", "constructor", "value"][n]!,
        make(depth - 1),
      ]),
    );
  };
  for (let i = 0; i < 300; i++) {
    const value = { root: make(4) };
    const before = JSON.stringify(value);
    expect(digestCanonicalJson(value)).toBe(previousDigest(value));
    expect(JSON.stringify(value)).toBe(before);
  }
  expect(Object.prototype).not.toHaveProperty("polluted");
});

test("canonical traversal preserves accessor, proxy and toJSON evaluation order", () => {
  function fixture(trace: string[]) {
    const child = new Proxy(
      { z: 1, a: 2 },
      {
        ownKeys(target) {
          trace.push("child.keys");
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          trace.push(`child.descriptor:${String(key)}`);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get(target, key, receiver) {
          trace.push(`child.get:${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
      },
    );
    return {
      get z() {
        trace.push("z");
        return child;
      },
      get a() {
        trace.push("a");
        return {
          get value() {
            trace.push("nested.value");
            return 3;
          },
        };
      },
      get toJSON() {
        trace.push("get.toJSON");
        return function (this: Record<string, unknown>, key: string) {
          trace.push(`call.toJSON:${key}:${Object.keys(this).join(",")}`);
          return { z: this.z, a: this.a };
        };
      },
    };
  }
  const before: string[] = [];
  const after: string[] = [];
  expect(digestCanonicalJson(fixture(after))).toBe(previousDigest(fixture(before)));
  expect(after).toEqual(before);
  expect(after.slice(0, 3)).toEqual(["z", "a", "get.toJSON"]);
});

test("canonical traversal retains refusal and thrown-error identity", () => {
  for (const value of [undefined, Symbol("root"), () => 1, 1n, { nested: 1n }]) {
    const error = (fn: () => unknown) => {
      try {
        fn();
      } catch (caught) {
        return caught;
      }
      throw new Error("Expected refusal");
    };
    const base = error(() => previousDigest(value)) as Error;
    const actual = error(() => digestCanonicalJson(value)) as Error;
    expect(actual.constructor).toBe(base.constructor);
    expect(actual.message).toBe(base.message);
  }
  const thrown = new Error("decoder-owned failure");
  const value = {
    get a() {
      throw thrown;
    },
  };
  for (const digest of [previousDigest, digestCanonicalJson]) {
    try {
      digest(value);
      throw new Error("Expected refusal");
    } catch (error) {
      expect(error).toBe(thrown);
    }
  }
});
