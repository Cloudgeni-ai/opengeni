import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
  createJsonSafeSummary,
  createJsonSafeWarning,
  JSON_SAFE_MAX_DEPTH,
  redactPath,
  summarizeJsonSafeAdjustments,
  toJsonSafeValue,
  type JsonSafeAdjustment,
} from "../src/json-safe";
import { fingerprint, hostileGraph, isStrictJson } from "./hostile-values";

function convert(value: unknown) {
  const adjustments: JsonSafeAdjustment[] = [];
  const result = toJsonSafeValue(value, { onAdjustment: (entry) => adjustments.push(entry) });
  return { result, adjustments };
}

describe("toJsonSafeValue", () => {
  test("returns a valid JSON graph unchanged, by reference, with nothing reported", () => {
    const shared = { id: 1 };
    const value = { a: [shared, shared, "x", 1.5, true, null], b: Object.create(null) };
    const { result, adjustments } = convert(value);
    expect(result).toBe(value);
    expect(adjustments).toEqual([]);
  });

  test("converts each kind of value as JSON.stringify would and reports its path", () => {
    const mark = Symbol("mark");
    const getter = { calls: 0 };
    const record = Object.defineProperties(
      { kept: "yes" },
      {
        lazy: {
          enumerable: true,
          get: () => {
            getter.calls += 1;
            return "never";
          },
        },
        hidden: { value: "hidden", enumerable: false },
      },
    );
    const holes = [1, , 3]; // oxlint-disable-line no-sparse-arrays
    const extra = Object.assign(["a"], { note: "dropped" });
    const cases: Array<[string, unknown, unknown, JsonSafeAdjustment[]]> = [
      ["symbol key", { a: 1, [mark]: 2 }, { a: 1 }, [{ path: "$", kind: "symbol_key" }]],
      ["symbol value", { a: mark }, {}, [{ path: '$["a"]', kind: "symbol" }]],
      ["function", { run: () => 1 }, {}, [{ path: '$["run"]', kind: "function" }]],
      ["undefined property", { a: undefined, b: 1 }, { b: 1 }, []],
      ["undefined element", [undefined], [null], [{ path: "$[0]", kind: "undefined" }]],
      ["safe bigint", { n: 42n }, { n: 42 }, [{ path: '$["n"]', kind: "bigint" }]],
      [
        "large bigint",
        { n: 2n ** 64n },
        { n: "18446744073709551616" },
        [{ path: '$["n"]', kind: "bigint" }],
      ],
      ["NaN", [Number.NaN], [null], [{ path: "$[0]", kind: "non_finite_number" }]],
      ["-0", { z: -0 }, { z: 0 }, [{ path: '$["z"]', kind: "negative_zero" }]],
      ["array hole", holes, [1, null, 3], [{ path: "$[1]", kind: "array_hole" }]],
      ["array property", extra, ["a"], [{ path: '$["note"]', kind: "array_property" }]],
      [
        "accessor and hidden",
        record,
        { kept: "yes" },
        [
          { path: '$["lazy"]', kind: "accessor" },
          { path: '$["hidden"]', kind: "hidden_property" },
        ],
      ],
      [
        "Date",
        { at: new Date(0) },
        { at: "1970-01-01T00:00:00.000Z" },
        [{ path: '$["at"]', kind: "to_json", type: "Date" }],
      ],
      [
        "Error",
        { error: Object.assign(new RangeError("bad"), { code: "E", status: 400, body: "x" }) },
        { error: { name: "RangeError", message: "bad", code: "E", status: 400 } },
        [{ path: '$["error"]', kind: "error", type: "RangeError" }],
      ],
      [
        "Map with string keys",
        new Map([["a", 1n]]),
        { a: 1 },
        [
          { path: "$", kind: "collection", type: "Map" },
          { path: '$["a"]', kind: "bigint" },
        ],
      ],
      [
        "Map with other keys",
        new Map([[1, "one"]]),
        [[1, "one"]],
        [{ path: "$", kind: "collection", type: "Map" }],
      ],
      ["Set", new Set(["a"]), ["a"], [{ path: "$", kind: "collection", type: "Set" }]],
      [
        "binary",
        { bytes: new Uint8Array([1]) },
        { bytes: null },
        [{ path: '$["bytes"]', kind: "binary", type: "Uint8Array" }],
      ],
      [
        "boxed primitive",
        { s: new String("s") },
        { s: "s" },
        [{ path: '$["s"]', kind: "class_instance", type: "String" }],
      ],
      [
        "AbortSignal",
        { signal: new AbortController().signal },
        { signal: {} },
        [{ path: '$["signal"]', kind: "class_instance", type: "AbortSignal" }],
      ],
    ];
    for (const [label, input, expected, reports] of cases) {
      const { result, adjustments } = convert(input);
      expect({ label, result }).toEqual({ label, result: expected } as never);
      expect({ label, adjustments }).toEqual({ label, adjustments: reports });
    }
    expect(getter.calls).toBe(0);
  });

  test("a cycle becomes null at the repeated reference; a shared reference is kept", () => {
    const cyclic: Record<string, unknown> = { id: "a" };
    cyclic.self = cyclic;
    const shared = { id: "s" };
    const { result, adjustments } = convert({ cyclic, left: shared, right: shared, f: () => 1 });
    expect(result).toEqual({ cyclic: { id: "a", self: null }, left: shared, right: shared });
    expect(adjustments).toContainEqual({ path: '$["cyclic"]["self"]', kind: "cycle" });
  });

  test("depth is bounded, including chains of toJSON", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < JSON_SAFE_MAX_DEPTH + 10; index += 1) deep = { deep };
    const { result, adjustments } = convert(deep);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(adjustments.map(({ kind }) => kind)).toEqual(["depth"]);

    class Endless {
      toJSON() {
        return new Endless();
      }
    }
    expect(() => toJsonSafeValue(new Endless())).not.toThrow();
    expect(toJsonSafeValue(new Endless())).toBeNull();
  });

  test("a value that cannot be read becomes null", () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    class Throws {
      toJSON() {
        throw new Error("toJSON");
      }
    }
    const { result, adjustments } = convert({ revoked: revocable.proxy, throws: new Throws() });
    expect(result).toEqual({ revoked: null, throws: null });
    expect(adjustments.filter(({ kind }) => kind === "unreadable").length).toBe(2);
  });

  test("a huge sparse array is replaced instead of walked", () => {
    const sparse: unknown[] = [];
    sparse.length = 2 ** 31;
    const started = performance.now();
    expect(convert({ sparse }).result).toEqual({ sparse: null });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("an undefined root becomes null and keeps __proto__ an own key", () => {
    expect(toJsonSafeValue(undefined)).toBeNull();
    const converted = toJsonSafeValue(
      JSON.parse('{"__proto__":{"polluted":true},"f":-0}') as Record<string, unknown>,
    ) as Record<string, unknown>;
    expect(Object.hasOwn(converted, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("plain objects from another realm are copied into this realm", () => {
    const foreign = runInNewContext("({ a: { b: [1] } })");
    const { result, adjustments } = convert(foreign);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result).toEqual({ a: { b: [1] } });
    expect(adjustments).toEqual([]);
  });

  test("summaries carry kinds and paths only", () => {
    const adjustments: JsonSafeAdjustment[] = Array.from({ length: 7 }, (_, index) => ({
      path: `$[${index}]`,
      kind: index % 2 ? "bigint" : "error",
      ...(index % 2 ? {} : { type: "Error" }),
    }));
    expect(summarizeJsonSafeAdjustments(adjustments)).toEqual({
      count: 7,
      kinds: { "error:Error": 4, bigint: 3 },
      paths: ["$[0]", "$[1]", "$[2]", "$[3]", "$[4]"],
    });
  });

  test("a non-enumerable array element is kept and marks the array changed", () => {
    const array = Object.defineProperty([1, 2], 0, { value: 1, enumerable: false });
    const { result } = convert({ array });
    expect(result).toEqual({ array: [1, 2] });
    expect((result as { array: unknown }).array).not.toBe(array);
    expect(
      Object.getOwnPropertyDescriptor((result as { array: unknown[] }).array, 0)?.enumerable,
    ).toBe(true);
  });

  test("a proxy whose traps fail on a later read is converted once, without throwing", () => {
    let reads = 0;
    const stateful = new Proxy(
      { a: 1 },
      {
        ownKeys(target) {
          reads += 1;
          if (reads > 1) throw new Error("trap");
          return Reflect.ownKeys(target);
        },
      },
    );
    const first = toJsonSafeValue({ stateful }, { copy: true });
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    // The second read fails; it still converts instead of throwing.
    expect(toJsonSafeValue({ stateful } as unknown, { copy: true })).toEqual({ stateful: null });
  });

  test("Errors, Maps and Sets from another realm keep their content", () => {
    const { result } = convert({
      error: runInNewContext('Object.assign(new Error("foreign"), { code: "E_F" })'),
      map: runInNewContext('new Map([["k", 1]])'),
      set: runInNewContext("new Set([1, 2])"),
    });
    const converted = result as { error: Record<string, unknown>; map: unknown; set: unknown };
    expect(converted.error.message).toBe("foreign");
    expect(converted.error.code).toBe("E_F");
    expect(converted.map).toEqual(toJsonSafeValue(new Map([["k", 1]])));
    expect(converted.set).toEqual(toJsonSafeValue(new Set([1, 2])));
  });

  test("a deep graph of shared references converts in linear time", () => {
    let node: Record<string, unknown> = { leaf: () => "function" };
    for (let level = 0; level < 30; level += 1) node = { left: node, right: node };
    const summary = createJsonSafeSummary();
    const started = performance.now();
    const result = toJsonSafeValue(node, { onAdjustment: summary.onAdjustment });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(summary.result()?.count).toBe(1);
    // Sharing is kept (walking the result as a tree would take 2^30 steps).
    let current = result as Record<string, unknown>;
    for (let level = 0; level < 30; level += 1) {
      expect(current.left).toBe(current.right);
      current = current.left as Record<string, unknown>;
    }
    expect(current).toEqual({});
  });

  test("logged paths keep identifier keys and indices and hide other keys", () => {
    expect(redactPath('$["alice@example.com"]["ssn"][3]')).toBe('$[*]["ssn"][3]');
    expect(redactPath('$["d2fc3220-9511-41ab-9b18-d825aac3f161"]["deadbeefdeadbeef"]["id"]')).toBe(
      '$[*][*]["id"]',
    );
    const summary = createJsonSafeSummary();
    toJsonSafeValue({ "file name.txt": { size: 1n } }, { onAdjustment: summary.onAdjustment });
    expect(summary.result()).toEqual({
      count: 1,
      kinds: { bigint: 1 },
      paths: ['$[*]["size"]'],
    });
  });

  test("real losses take the logged path slots before lossless changes", () => {
    const summary = createJsonSafeSummary();
    toJsonSafeValue([-0, -0, -0, -0, -0, -0, () => 1], { onAdjustment: summary.onAdjustment });
    expect(summary.result()?.paths[0]).toBe("$[6]");
    expect(summary.result()?.paths).toHaveLength(5);
  });

  test("quiet adjustments alone produce no summary", () => {
    const summary = createJsonSafeSummary();
    toJsonSafeValue(
      { a: undefined, b: -0, [Symbol("mark")]: true },
      { onAdjustment: summary.onAdjustment },
    );
    expect(summary.result()).toBeNull();
  });

  test("warnings are rate limited per context and kinds", () => {
    const lines: object[] = [];
    const warn = createJsonSafeWarning("adjusted", {
      warn: (_message, detail) => lines.push(detail),
    });
    const summary = { count: 1, kinds: { bigint: 1 }, paths: ["$"] };
    warn({ rootPath: "$" }, summary);
    warn({ rootPath: "$" }, summary);
    warn({ rootPath: "$.other" }, summary);
    // History rows that differ only by index share one line.
    warn({ rootPath: "$[1]" }, summary);
    warn({ rootPath: "$[2]" }, summary);
    expect(lines.length).toBe(3);
  });
});

describe("toJsonSafeValue on seeded hostile graphs", () => {
  const seeds = Array.from({ length: 400 }, (_, index) => index * 7919 + 17);

  test("never throws, returns strict JSON, is stable and idempotent, and never mutates", () => {
    for (const seed of seeds) {
      const graph = hostileGraph(seed);
      const before = fingerprint(graph.value);
      let result: unknown;
      try {
        result = toJsonSafeValue(graph.value, { onAdjustment: () => undefined });
      } catch (error) {
        throw new Error(`seed ${seed} threw`, { cause: error });
      }
      if (!isStrictJson(result)) throw new Error(`seed ${seed} returned a non-JSON value`);
      // JSON round trip is lossless for the converted value.
      const text = JSON.stringify(result);
      expect(JSON.stringify(JSON.parse(text))).toBe(text);
      // Converting again changes and reports nothing.
      const again = convert(result);
      expect(again.result).toBe(result);
      expect(again.adjustments).toEqual([]);
      // The input is untouched and no getter ran.
      expect(fingerprint(graph.value)).toBe(before);
      expect(graph.getterCalls()).toBe(0);
    }
  });
});
