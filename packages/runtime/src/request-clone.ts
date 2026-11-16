import { types } from "node:util";

/**
 * `structuredClone(value)` with a faster path for the plain JSON-like data a
 * model request carries (tool definitions, model settings).
 *
 * The fast path copies only ordinary objects and dense arrays whose own
 * enumerable properties are exactly what `structuredClone` would copy, and
 * keeps shared and cyclic references shared, as `structuredClone` does. On the
 * first value it does not handle exactly (a class instance, Date, Map, typed
 * array, Proxy, function, symbol, sparse array, an array with extra
 * properties, a `__proto__` own key) it discards its partial copy and returns
 * `structuredClone(value)`, so the result and any thrown error are always
 * those of `structuredClone`. On the fast path each getter runs once, in
 * property order. On the fallback path, getters the fast path already read
 * run again inside `structuredClone`, so a getter with side effects can run
 * twice; model request data is plain values and has none.
 */
export function cloneRequestValue<T>(value: T): T {
  if (typeof value !== "object" || value === null) return structuredClone(value);
  const copies = new Map<object, unknown>();
  const copied = copyPlain(value, copies);
  return copied === UNSUPPORTED ? structuredClone(value) : (copied as T);
}

const UNSUPPORTED: unique symbol = Symbol("unsupported");

function copyPlain(value: unknown, copies: Map<object, unknown>): unknown {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "undefined":
    case "bigint":
      return value;
    case "object":
      break;
    default:
      // Functions and symbols make structuredClone throw.
      return UNSUPPORTED;
  }
  if (value === null) return null;
  const known = copies.get(value);
  if (known !== undefined) return known;
  if (types.isProxy(value)) return UNSUPPORTED;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Array.prototype && Array.isArray(value)) {
    const source = value as unknown[];
    const length = source.length;
    const out: unknown[] = new Array(length);
    copies.set(value, out);
    for (let index = 0; index < length; index++) {
      const entry = source[index];
      if (entry === undefined && !(index in source)) return UNSUPPORTED;
      const next = copyPlain(entry, copies);
      if (next === UNSUPPORTED) return UNSUPPORTED;
      out[index] = next;
    }
    // Named properties on an array are copied by structuredClone too.
    if (Object.keys(source).length !== length) return UNSUPPORTED;
    return out;
  }
  if (prototype !== Object.prototype) return UNSUPPORTED;
  const out: Record<string, unknown> = {};
  copies.set(value, out);
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (key === "__proto__") return UNSUPPORTED;
    const next = copyPlain(source[key], copies);
    if (next === UNSUPPORTED) return UNSUPPORTED;
    out[key] = next;
  }
  return out;
}
