import { runInNewContext } from "node:vm";

/**
 * Seeded random graphs of the values SDKs, tools, errors and events can hand
 * to a JSON boundary: symbol keys and values, functions, bigints, non-finite
 * numbers, -0, cycles, shared references, class instances (Date, Error,
 * Map, Set, binary data, Headers, AbortSignal, a Response), accessors, hidden
 * properties, array holes and extra properties, boxed primitives, objects
 * from another realm, null-prototype objects, throwing proxies and toJSON,
 * and deep nesting.
 */
export type HostileGraph = {
  value: unknown;
  /** Called when a getter is invoked; a JSON boundary must never call one. */
  getterCalls: () => number;
};

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hostileGraph(seed: number, maxDepth = 6): HostileGraph {
  const random = seededRandom(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  let getterCalls = 0;
  const containers: object[] = [];

  const leaf = (): unknown =>
    pick<() => unknown>([
      () => "text",
      () => "nul\u0000and lone \ud800 surrogate",
      () => "",
      () => 0,
      () => -0,
      () => 1.5,
      () => Number.NaN,
      () => Number.POSITIVE_INFINITY,
      () => Number.MAX_SAFE_INTEGER,
      () => 7n,
      () => 2n ** 70n,
      () => true,
      () => null,
      () => undefined,
      () => Symbol("value"),
      () => () => "function",
      () => new Date(random() * 1e12),
      () => new Date(Number.NaN),
      () => Object.assign(new Error("boom"), { code: "E_X", status: 500, extra: "dropped" }),
      () => new TypeError("type"),
      () => new Uint8Array([1, 2, 3]),
      () => new ArrayBuffer(4),
      () => new URL("https://example.com/path?q=1"),
      () => new Headers({ "x-request-id": "r1" }),
      () => new AbortController().signal,
      () => new Response("body", { status: 201 }),
      () => new String("boxed"),
      () => new Number(-0),
      () => Object(5n),
      () => /regex/g,
      () => new WeakMap(),
      () =>
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("trap");
            },
          },
        ),
      () => {
        const revocable = Proxy.revocable({}, {});
        revocable.revoke();
        return revocable.proxy;
      },
      () => ({
        toJSON() {
          throw new Error("toJSON");
        },
      }),
      () => runInNewContext('({ foreign: { realm: [1, "two"] } })'),
      () => runInNewContext('new Error("foreign error")'),
      () => runInNewContext('new Map([["foreign", 1]])'),
      () => runInNewContext("new Set([1, 2])"),
      () => Object.defineProperty([1, 2], 0, { value: "hidden element", enumerable: false }),
      () => Object.assign(Object.create(null), { bare: true }),
    ])();

  const node = (depth: number): unknown => {
    if (depth >= maxDepth || random() < 0.3) {
      // Sometimes a back reference (a cycle) or a shared reference.
      if (containers.length > 0 && random() < 0.15) return pick(containers);
      return leaf();
    }
    const kind = random();
    if (kind < 0.35) {
      const array: unknown[] = [];
      containers.push(array);
      const length = Math.floor(random() * 5);
      for (let index = 0; index < length; index += 1) {
        if (random() < 0.1) continue; // a hole
        array[index] = node(depth + 1);
      }
      array.length = length;
      if (random() < 0.1) Object.assign(array, { extra: node(depth + 1) });
      if (random() < 0.1) Object.assign(array, { [Symbol("array mark")]: true });
      return array;
    }
    if (kind < 0.45) {
      const map = new Map<unknown, unknown>();
      containers.push(map);
      map.set("key", node(depth + 1));
      if (random() < 0.5) map.set(pick([1, {}, Symbol("k")]), node(depth + 1));
      return map;
    }
    if (kind < 0.5) {
      const set = new Set<unknown>([node(depth + 1), node(depth + 1)]);
      containers.push(set);
      return set;
    }
    if (kind < 0.55) {
      // A class instance with its own data, as SDK response objects are.
      class SdkResponse {
        id = "resp_1";
        nested: unknown = node(depth + 1);
      }
      const instance = new SdkResponse();
      containers.push(instance);
      return instance;
    }
    const record: Record<PropertyKey, unknown> = {};
    containers.push(record);
    const keys = Math.floor(random() * 6);
    for (let index = 0; index < keys; index += 1) {
      const key = pick(["a", "b", "__proto__", "constructor", "toJSON", "0", "x\u0000y", "type"]);
      Object.defineProperty(record, key, {
        value: node(depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    if (random() < 0.2) record[Symbol("request mark")] = node(depth + 1);
    if (random() < 0.1) {
      Object.defineProperty(record, "getter", {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return "invoked";
        },
      });
    }
    if (random() < 0.1) {
      Object.defineProperty(record, "hidden", { value: "hidden", enumerable: false });
    }
    return record;
  };

  return { value: node(0), getterCalls: () => getterCalls };
}

/** A structural fingerprint of everything reachable, read without invoking getters or proxies. */
export function fingerprint(value: unknown): string {
  const seen = new Map<object, number>();
  const out: string[] = [];
  const visit = (current: unknown): void => {
    if (current === null || (typeof current !== "object" && typeof current !== "function")) {
      out.push(
        typeof current === "symbol"
          ? "symbol"
          : typeof current === "bigint"
            ? `${current}n`
            : Object.is(current, -0)
              ? "-0"
              : `${typeof current}:${String(current)}`,
      );
      return;
    }
    if (typeof current === "function") {
      out.push("function");
      return;
    }
    const known = seen.get(current);
    if (known !== undefined) {
      out.push(`ref:${known}`);
      return;
    }
    seen.set(current, seen.size);
    let descriptors: Record<PropertyKey, PropertyDescriptor>;
    try {
      descriptors = Object.getOwnPropertyDescriptors(current) as Record<
        PropertyKey,
        PropertyDescriptor
      >;
    } catch {
      out.push("unreadable");
      return;
    }
    out.push("{");
    for (const key of Reflect.ownKeys(descriptors)) {
      out.push(typeof key === "symbol" ? "@symbol" : JSON.stringify(key));
      const descriptor = descriptors[key]!;
      if ("value" in descriptor) visit(descriptor.value);
      else out.push("accessor");
    }
    if (current instanceof Map) {
      for (const [key, entry] of current) {
        visit(key);
        visit(entry);
      }
    }
    if (current instanceof Set) for (const v of current) visit(v);
    out.push("}");
  };
  visit(value);
  return out.join(",");
}

/** Whether a value is exactly a JSON graph: plain objects and arrays of JSON values, no cycles. */
export function isStrictJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (Object.keys(descriptors).length !== value.length + 1) return false;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
        if (!isStrictJson(descriptor.value, ancestors)) return false;
      }
      return true;
    }
    for (const descriptor of Object.values(descriptors)) {
      if (!("value" in descriptor) || !descriptor.enumerable) return false;
      if (!isStrictJson(descriptor.value, ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}
