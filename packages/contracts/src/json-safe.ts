/**
 * The JSON form of any JavaScript value, for a boundary that must store or
 * send it and must never fail because of it.
 *
 * Valid JSON graphs (plain objects, arrays, strings, booleans, null and finite
 * numbers) come back unchanged, with their references. Everything else is
 * converted the way `JSON.stringify` would, or dropped where it would throw,
 * and each change is reported with the exact path of the value:
 *
 * - an `undefined` object property is omitted silently (JSON omits it too);
 *   functions, symbols and symbol-keyed properties are omitted, or become
 *   `null` in an array;
 * - a bigint becomes a number when it is a safe integer, otherwise its decimal
 *   string; a non-finite number becomes `null` and `-0` becomes `0`;
 * - a cyclic reference, a value deeper than the depth limit, an array hole and
 *   a value that cannot be read (a throwing proxy or `toJSON`) become `null`;
 * - accessors and hidden properties are dropped without invoking them;
 * - a value with `toJSON` (a Date, a URL) becomes its `toJSON()` result, an
 *   Error its `name`, `message` and scalar `code`/`status`, a Map an object
 *   (or an entry list for non-string keys), a Set an array, binary data
 *   `null`, and any other class instance (a Response, Headers, AbortSignal)
 *   its own enumerable data properties, as `JSON.stringify` does.
 *
 * Inputs are never mutated. The result is stable: converting it again returns
 * it unchanged and reports nothing.
 */
export type JsonSafeAdjustmentKind =
  | "symbol_key"
  | "function"
  | "symbol"
  | "undefined"
  | "bigint"
  | "non_finite_number"
  | "negative_zero"
  | "cycle"
  | "depth"
  | "array_hole"
  | "array_property"
  | "accessor"
  | "hidden_property"
  | "to_json"
  | "error"
  | "collection"
  | "binary"
  | "class_instance"
  | "unreadable";

export type JsonSafeAdjustment = {
  /** JSONPath-like location, for example `$["item"]["content"][2]`. */
  path: string;
  kind: JsonSafeAdjustmentKind;
  /** The constructor name of a converted class instance, when it has one. */
  type?: string;
};

export type JsonSafeOptions = {
  /** Root of every reported path. Defaults to `$`. */
  rootPath?: string;
  /** Called once per converted or dropped value, in traversal order. */
  onAdjustment?: (adjustment: JsonSafeAdjustment) => void;
};

export const JSON_SAFE_MAX_DEPTH = 512;
/** An array with more holes than this is replaced, not walked element by element. */
const MAX_ARRAY_HOLES = 100_000;

const OMIT: unique symbol = Symbol("omit");
type Converted = { value: unknown; changed: boolean } | typeof OMIT;

type Walk = {
  ancestors: Set<object>;
  report: (path: string, kind: JsonSafeAdjustmentKind, type?: string) => void;
};

export function toJsonSafeValue<T>(value: T, options: JsonSafeOptions = {}): T {
  const onAdjustment = options.onAdjustment;
  const walk: Walk = {
    ancestors: new Set(),
    report: (path, kind, type) => {
      if (!onAdjustment) return;
      onAdjustment(type ? { path, kind, type } : { path, kind });
    },
  };
  const converted = convert(value, options.rootPath ?? "$", 0, walk);
  if (converted !== OMIT) return converted.value as T;
  if (value === undefined) walk.report(options.rootPath ?? "$", "undefined");
  return null as T;
}

/** Count adjustments by kind, for a compact log line. */
export function summarizeJsonSafeAdjustments(
  adjustments: readonly JsonSafeAdjustment[],
  maxPaths = 5,
): { count: number; kinds: Record<string, number>; paths: string[] } {
  const kinds: Record<string, number> = {};
  for (const adjustment of adjustments) {
    const key = adjustment.type ? `${adjustment.kind}:${adjustment.type}` : adjustment.kind;
    kinds[key] = (kinds[key] ?? 0) + 1;
  }
  return {
    count: adjustments.length,
    kinds,
    paths: adjustments.slice(0, maxPaths).map(({ path }) => truncatePath(path)),
  };
}

function truncatePath(path: string): string {
  return path.length > 160 ? `${path.slice(0, 157)}...` : path;
}

function convert(value: unknown, path: string, depth: number, walk: Walk): Converted {
  switch (typeof value) {
    case "string":
    case "boolean":
      return { value, changed: false };
    case "number":
      if (Object.is(value, -0)) {
        walk.report(path, "negative_zero");
        return { value: 0, changed: true };
      }
      if (!Number.isFinite(value)) {
        walk.report(path, "non_finite_number");
        return { value: null, changed: true };
      }
      return { value, changed: false };
    case "bigint": {
      walk.report(path, "bigint");
      const number = Number(value);
      return { value: Number.isSafeInteger(number) ? number : value.toString(), changed: true };
    }
    case "undefined":
      return OMIT;
    case "function":
      walk.report(path, "function");
      return OMIT;
    case "symbol":
      walk.report(path, "symbol");
      return OMIT;
  }
  if (value === null) return { value, changed: false };
  const object = value as object;
  if (depth >= JSON_SAFE_MAX_DEPTH) {
    walk.report(path, "depth");
    return { value: null, changed: true };
  }
  if (walk.ancestors.has(object)) {
    walk.report(path, "cycle");
    return { value: null, changed: true };
  }
  walk.ancestors.add(object);
  try {
    return convertObject(object, path, depth, walk);
  } catch {
    // A proxy trap, toJSON or other hook threw while the value was read.
    walk.report(path, "unreadable");
    return { value: null, changed: true };
  } finally {
    walk.ancestors.delete(object);
  }
}

function convertObject(value: object, path: string, depth: number, walk: Walk): Converted {
  if (Array.isArray(value)) return convertArray(value, path, depth, walk);
  if (isPlainObject(value)) return convertRecord(value, path, depth, walk, false);
  const type = constructorName(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    walk.report(path, "binary", type);
    return { value: null, changed: true };
  }
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    walk.report(path, "to_json", type);
    // A toJSON result counts one level deeper, so a chain of them is bounded.
    const json = convert(toJSON.call(value, ""), path, depth + 1, walk);
    return json === OMIT ? OMIT : { value: json.value, changed: true };
  }
  if (value instanceof Error) {
    walk.report(path, "error", type);
    const error: Record<string, unknown> = {
      name: typeof value.name === "string" ? value.name : "Error",
      message: typeof value.message === "string" ? value.message : "",
    };
    for (const key of ["code", "status"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const field = descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (typeof field === "string" || (typeof field === "number" && Number.isFinite(field)))
        error[key] = field;
    }
    return { value: error, changed: true };
  }
  if (value instanceof Map) {
    walk.report(path, "collection", type);
    const entries = [...value.entries()];
    if (entries.every(([key]) => typeof key === "string")) {
      const record: Record<string, unknown> = {};
      for (const [key, entry] of entries) {
        const converted = convert(entry, `${path}[${JSON.stringify(key)}]`, depth + 1, walk);
        if (converted !== OMIT) defineData(record, key as string, converted.value);
      }
      return { value: record, changed: true };
    }
    const list = convert(entries, path, depth + 1, walk);
    return list === OMIT ? OMIT : { value: list.value, changed: true };
  }
  if (value instanceof Set) {
    walk.report(path, "collection", type);
    const list = convert([...value.values()], path, depth + 1, walk);
    return list === OMIT ? OMIT : { value: list.value, changed: true };
  }
  if (value instanceof String || value instanceof Number || value instanceof Boolean) {
    walk.report(path, "class_instance", type);
    const primitive = convert(value.valueOf(), path, depth + 1, walk);
    return primitive === OMIT ? OMIT : { value: primitive.value, changed: true };
  }
  walk.report(path, "class_instance", type);
  return convertRecord(value as Record<string, unknown>, path, depth, walk, true);
}

function convertArray(value: unknown[], path: string, depth: number, walk: Walk): Converted {
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
    string | symbol,
    PropertyDescriptor
  >;
  let changed = false;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") {
      walk.report(path, "symbol_key");
      changed = true;
    } else if (key !== "length" && !isArrayIndex(key, value.length)) {
      walk.report(`${path}[${JSON.stringify(key)}]`, "array_property");
      changed = true;
    }
  }
  const indexCount = Object.keys(descriptors).filter((key) =>
    isArrayIndex(key, value.length),
  ).length;
  if (value.length - indexCount > MAX_ARRAY_HOLES) {
    walk.report(path, "array_hole");
    return { value: null, changed: true };
  }
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const descriptor = descriptors[String(index)];
    if (!descriptor) {
      walk.report(itemPath, "array_hole");
      output.push(null);
      changed = true;
      continue;
    }
    if (!("value" in descriptor)) {
      walk.report(itemPath, "accessor");
      output.push(null);
      changed = true;
      continue;
    }
    const converted = convert(descriptor.value, itemPath, depth + 1, walk);
    if (converted === OMIT) {
      // JSON writes an unrepresentable array element as null.
      if (descriptor.value === undefined) walk.report(itemPath, "undefined");
      output.push(null);
      changed = true;
      continue;
    }
    output.push(converted.value);
    changed ||= converted.changed;
  }
  return changed ? { value: output, changed: true } : { value, changed: false };
}

function convertRecord(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  walk: Walk,
  forceCopy: boolean,
): Converted {
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string | symbol,
    PropertyDescriptor
  >;
  const prototype = Object.getPrototypeOf(value);
  const output = Object.create(prototype === null ? null : Object.prototype) as Record<
    string,
    unknown
  >;
  // A plain object from another realm is copied into this realm's prototype.
  let changed = forceCopy || (prototype !== Object.prototype && prototype !== null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") {
      walk.report(path, "symbol_key");
      changed = true;
      continue;
    }
    const descriptor = descriptors[key]!;
    const propertyPath = `${path}[${JSON.stringify(key)}]`;
    if (!("value" in descriptor)) {
      walk.report(propertyPath, "accessor");
      changed = true;
      continue;
    }
    if (!descriptor.enumerable) {
      walk.report(propertyPath, "hidden_property");
      changed = true;
      continue;
    }
    const converted = convert(descriptor.value, propertyPath, depth + 1, walk);
    if (converted === OMIT) {
      changed = true;
      continue;
    }
    defineData(output, key, converted.value);
    changed ||= converted.changed;
  }
  return changed ? { value: output, changed: true } : { value, changed: false };
}

function defineData(target: Record<string, unknown>, key: string, value: unknown): void {
  // defineProperty keeps "__proto__" an own data key instead of a prototype write.
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function constructorName(value: object): string | undefined {
  try {
    const name = (Object.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null)
      ?.constructor?.name;
    return typeof name === "string" && name ? name.slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A plain object of this or another JavaScript realm. A value from a
 * VM-backed sandbox provider has that realm's own Object.prototype.
 */
function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) return true;
  if (Object.getPrototypeOf(prototype) !== null) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  return (
    typeof constructor === "function" &&
    constructor.name === "Object" &&
    Function.prototype.toString.call(constructor).includes("[native code]")
  );
}
