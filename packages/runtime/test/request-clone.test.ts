import { expect, test } from "bun:test";
import { cloneRequestValue } from "../src/request-clone";

/** Structure, prototypes, property order and shared references, exactly. */
function shape(value: unknown, seen = new Map<object, number>()): unknown {
  if (typeof value !== "object" || value === null) {
    return Object.is(value, -0)
      ? "-0"
      : typeof value === "number" && Number.isNaN(value)
        ? "NaN"
        : value;
  }
  const known = seen.get(value);
  if (known !== undefined) return { ref: known };
  seen.set(value, seen.size);
  const prototype = Object.getPrototypeOf(value);
  return {
    kind:
      prototype === Object.prototype
        ? "object"
        : prototype === Array.prototype
          ? "array"
          : prototype === null
            ? "null-prototype"
            : (prototype.constructor?.name ?? "other"),
    frozen: Object.isFrozen(value),
    keys: Reflect.ownKeys(value).map(String),
    entries: Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, descriptor]) => [
      key,
      descriptor.enumerable,
      "value" in descriptor ? shape(descriptor.value, seen) : "accessor",
    ]),
  };
}

function outcome(run: () => unknown): unknown {
  try {
    return { value: shape(run()) };
  } catch (error) {
    return { error: (error as Error).name, message: (error as Error).message };
  }
}

function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
}

function tree(next: () => number, depth: number, pool: object[]): unknown {
  const roll = Math.floor(next() * (depth > 4 ? 5 : 9));
  switch (roll) {
    case 0:
      return "s".repeat(Math.floor(next() * 5)) + "é😀";
    case 1:
      return next() < 0.2 ? -0 : Math.floor(next() * 100) - 50;
    case 2:
      return [true, false, null, undefined, Number.NaN][Math.floor(next() * 5)];
    case 3:
      return pool.length && next() < 0.5 ? pool[Math.floor(next() * pool.length)] : 7n;
    case 4:
      return "key";
    case 5:
    case 6: {
      const out: Record<string, unknown> = {};
      pool.push(out);
      for (let i = 0; i < Math.floor(next() * 5); i++) {
        out[["type", "name", "10", "2", "description", "parameters"][Math.floor(next() * 6)]!] =
          tree(next, depth + 1, pool);
      }
      return out;
    }
    default: {
      const out: unknown[] = [];
      pool.push(out);
      for (let i = 0; i < Math.floor(next() * 4); i++) out.push(tree(next, depth + 1, pool));
      return out;
    }
  }
}

test("cloneRequestValue equals structuredClone on randomized plain request data", () => {
  for (let seed = 1; seed <= 500; seed++) {
    const next = random(seed);
    const pool: object[] = [];
    const value = tree(next, 0, pool);
    if (pool.length > 2 && next() < 0.3) {
      // A cycle through a container.
      const container = pool[Math.floor(next() * pool.length)]!;
      if (Array.isArray(container)) container.push(pool[0]);
      else (container as Record<string, unknown>).cycle = pool[0];
    }
    expect(outcome(() => cloneRequestValue(value))).toEqual(outcome(() => structuredClone(value)));
  }
});

test("cloneRequestValue returns structuredClone's result or error for every unusual value", () => {
  class Tool {
    name = "tool";
  }
  const sparse = [1, 2, 3];
  delete sparse[1];
  const named = Object.assign([1, 2], { extra: true });
  const accessor = {
    get computed() {
      return { nested: 1 };
    },
  };
  const hidden = Object.defineProperty({ visible: 1 }, "hidden", { value: 2, enumerable: false });
  const withSymbol = { visible: 1, [Symbol("mark")]: 2 };
  const proto = JSON.parse('{"__proto__": {"x": 1}, "y": 2}');
  const frozen = Object.freeze({ a: Object.freeze([1]) });
  const values: unknown[] = [
    undefined,
    null,
    "text",
    1n,
    [new Tool()],
    { at: new Date(0) },
    { map: new Map([[1, 2]]) },
    { bytes: new Uint8Array([1, 2]) },
    { error: new Error("boom") },
    { regexp: /x/g },
    sparse,
    named,
    accessor,
    hidden,
    withSymbol,
    proto,
    frozen,
    Object.assign(Object.create(null), { a: 1 }),
    { fn: () => 1 },
    { symbol: Symbol("s") },
    { proxy: new Proxy({ a: 1 }, {}) },
    [{ type: "function", name: "a", parameters: { type: "object", properties: {} } }],
  ];
  for (const value of values) {
    expect(outcome(() => cloneRequestValue(value))).toEqual(outcome(() => structuredClone(value)));
  }
});

test("cloneRequestValue copies: the source can change without changing the clone", () => {
  const tools = [
    { type: "function", name: "a", parameters: { properties: { q: { type: "string" } } } },
  ];
  const copy = cloneRequestValue(tools);
  tools[0]!.parameters.properties.q.type = "number";
  expect(copy[0]!.parameters.properties.q.type).toBe("string");
  expect(copy).not.toBe(tools);
});
