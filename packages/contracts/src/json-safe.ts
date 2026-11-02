/**
 * The JSON form of any JavaScript value, for a boundary that must store or
 * send it and must never fail because of it.
 *
 * Valid JSON graphs (plain objects, arrays, strings, booleans, null and finite
 * numbers) come back unchanged, with their references. Everything else is
 * converted the way `JSON.stringify` would, or dropped where it would throw,
 * and each change is reported with the exact path of the value:
 *
 * - an `undefined` object property is omitted (JSON omits it too);
 *   functions, symbols and symbol-keyed properties are omitted, or become
 *   `null` in an array;
 * - a bigint becomes a number when it is a safe integer, otherwise its decimal
 *   string; a non-finite number becomes `null` and `-0` becomes `0`;
 * - a cyclic reference, an object deeper than the depth limit, an array hole
 *   and a value that cannot be read (a throwing proxy or `toJSON`) become
 *   `null`;
 * - own accessor properties are dropped without invoking them, and hidden
 *   (non-enumerable) properties are dropped; a hidden array element is kept,
 *   as `JSON.stringify` keeps it;
 * - a `toJSON` method (a Date, a URL, or a plain object's own) is called as
 *   `JSON.stringify` calls it (reading `toJSON` itself may run a getter, as
 *   it does in `JSON.stringify`); an Error becomes its `name`, `message`, scalar
 *   `code`/`status` and a short `cause` chain; a Map an object (or an entry
 *   list for non-string keys); a Set an array; binary data `null`; and any
 *   other class instance (a Response, Headers, AbortSignal) its own enumerable
 *   data properties. Errors, Maps, Sets and plain objects from another
 *   JavaScript realm are recognized too.
 *
 * A shared reference is converted once and shared in the result, so the work
 * is linear in the number of distinct objects. Inputs are never mutated. The
 * result is stable: converting it again returns it unchanged and reports
 * nothing.
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
  /**
   * Build every object and array afresh, even where the input is already
   * valid JSON, so nothing of the input (such as a proxy) remains in the
   * result. For a last-resort retry; reports the same adjustments.
   */
  copy?: boolean;
};

export const JSON_SAFE_MAX_DEPTH = 512;
/** An array with more holes than this is replaced, not walked element by element. */
const MAX_ARRAY_HOLES = 100_000;
/** Levels of `cause` kept on a converted Error. */
const MAX_ERROR_CAUSES = 3;

const OMIT: unique symbol = Symbol("omit");
type Converted = { value: unknown; changed: boolean } | typeof OMIT;

/** A path built only when something is reported. */
type Path = { parent: Path | null; segment: string | number };

type Walk = {
  root: string;
  copy: boolean;
  ancestors: Set<object>;
  /** Converted shared objects, with the depth they were converted at. */
  converted: WeakMap<object, { result: Converted; depth: number }>;
  onAdjustment: ((adjustment: JsonSafeAdjustment) => void) | undefined;
};

export function toJsonSafeValue<T>(value: T, options: JsonSafeOptions = {}): T {
  const walk: Walk = {
    root: options.rootPath ?? "$",
    copy: options.copy === true,
    ancestors: new Set(),
    converted: new WeakMap(),
    onAdjustment: options.onAdjustment,
  };
  const converted = convert(value, null, 0, walk);
  if (converted !== OMIT) return converted.value as T;
  if (value === undefined) report(walk, null, "undefined");
  return null as T;
}

function report(walk: Walk, path: Path | null, kind: JsonSafeAdjustmentKind, type?: string) {
  if (!walk.onAdjustment) return;
  const rendered = renderPath(walk.root, path);
  walk.onAdjustment(type ? { path: rendered, kind, type } : { path: rendered, kind });
}

function renderPath(root: string, path: Path | null): string {
  const segments: string[] = [];
  for (let current = path; current; current = current.parent) {
    segments.push(
      typeof current.segment === "number"
        ? `[${current.segment}]`
        : `[${JSON.stringify(current.segment)}]`,
    );
  }
  return root + segments.reverse().join("");
}

function child(parent: Path | null, segment: string | number): Path {
  return { parent, segment };
}

function convert(value: unknown, path: Path | null, depth: number, walk: Walk): Converted {
  switch (typeof value) {
    case "string":
    case "boolean":
      return { value, changed: false };
    case "number":
      if (Object.is(value, -0)) {
        report(walk, path, "negative_zero");
        return { value: 0, changed: true };
      }
      if (!Number.isFinite(value)) {
        report(walk, path, "non_finite_number");
        return { value: null, changed: true };
      }
      return { value, changed: false };
    case "bigint": {
      report(walk, path, "bigint");
      const number = Number(value);
      return { value: Number.isSafeInteger(number) ? number : value.toString(), changed: true };
    }
    case "undefined":
      return OMIT;
    case "function":
      report(walk, path, "function");
      return OMIT;
    case "symbol":
      report(walk, path, "symbol");
      return OMIT;
  }
  if (value === null) return { value, changed: false };
  const object = value as object;
  if (depth >= JSON_SAFE_MAX_DEPTH) {
    report(walk, path, "depth");
    return { value: null, changed: true };
  }
  if (walk.ancestors.has(object)) {
    report(walk, path, "cycle");
    return { value: null, changed: true };
  }
  // A shared reference converted at this depth or deeper fits here as well.
  const earlier = walk.converted.get(object);
  if (earlier && earlier.depth >= depth) return earlier.result;
  walk.ancestors.add(object);
  let result: Converted;
  try {
    result = convertObject(object, path, depth, walk);
  } catch {
    // A proxy trap, toJSON or other hook threw while the value was read.
    report(walk, path, "unreadable");
    result = { value: null, changed: true };
  } finally {
    walk.ancestors.delete(object);
  }
  walk.converted.set(object, { result, depth });
  return result;
}

function convertObject(value: object, path: Path | null, depth: number, walk: Walk): Converted {
  if (Array.isArray(value)) return convertArray(value, path, depth, walk);
  if (isPlainObject(value)) {
    const ownToJSON = Object.getOwnPropertyDescriptor(value, "toJSON");
    if (ownToJSON && "value" in ownToJSON && typeof ownToJSON.value === "function") {
      report(walk, path, "to_json");
      return viaToJSON(value, ownToJSON.value, path, depth, walk);
    }
    return convertRecord(value, path, depth, walk, false);
  }
  const brand = Object.prototype.toString.call(value);
  const type = constructorName(value);
  if (
    ArrayBuffer.isView(value) ||
    brand === "[object ArrayBuffer]" ||
    brand === "[object SharedArrayBuffer]"
  ) {
    report(walk, path, "binary", type);
    return { value: null, changed: true };
  }
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    report(walk, path, "to_json", type);
    return viaToJSON(value, toJSON as (...args: unknown[]) => unknown, path, depth, walk);
  }
  if (isError(value, brand)) {
    report(walk, path, "error", type);
    return { value: errorSummary(value, MAX_ERROR_CAUSES), changed: true };
  }
  if (isMap(value)) {
    report(walk, path, "collection", type);
    const entries = [...Map.prototype.entries.call(value)] as Array<[unknown, unknown]>;
    if (entries.every(([key]) => typeof key === "string")) {
      const record: Record<string, unknown> = {};
      for (const [key, entry] of entries) {
        const converted = convert(entry, child(path, key as string), depth + 1, walk);
        if (converted !== OMIT) defineData(record, key as string, converted.value);
      }
      return { value: record, changed: true };
    }
    const list = convert(entries, path, depth + 1, walk);
    return list === OMIT ? OMIT : { value: list.value, changed: true };
  }
  if (isSet(value)) {
    report(walk, path, "collection", type);
    const list = convert([...Set.prototype.values.call(value)], path, depth + 1, walk);
    return list === OMIT ? OMIT : { value: list.value, changed: true };
  }
  if (value instanceof String || value instanceof Number || value instanceof Boolean) {
    report(walk, path, "class_instance", type);
    const primitive = convert(value.valueOf(), path, depth + 1, walk);
    return primitive === OMIT ? OMIT : { value: primitive.value, changed: true };
  }
  report(walk, path, "class_instance", type);
  return convertRecord(value as Record<string, unknown>, path, depth, walk, true);
}

function viaToJSON(
  value: object,
  toJSON: (...args: unknown[]) => unknown,
  path: Path | null,
  depth: number,
  walk: Walk,
): Converted {
  // A toJSON result counts one level deeper, so a chain of them is bounded.
  const key = path === null ? "" : String(path.segment);
  const json = convert(toJSON.call(value, key), path, depth + 1, walk);
  return json === OMIT ? OMIT : { value: json.value, changed: true };
}

function convertArray(value: unknown[], path: Path | null, depth: number, walk: Walk): Converted {
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
    string | symbol,
    PropertyDescriptor
  >;
  const length = value.length;
  let changed = walk.copy;
  let indexCount = 0;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") {
      report(walk, path, "symbol_key");
      changed = true;
    } else if (isArrayIndex(key, length)) {
      indexCount += 1;
    } else if (key !== "length") {
      report(walk, child(path, key), "array_property");
      changed = true;
    }
  }
  if (length - indexCount > MAX_ARRAY_HOLES) {
    report(walk, path, "array_hole");
    return { value: null, changed: true };
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) {
      report(walk, child(path, index), "array_hole");
      output.push(null);
      changed = true;
      continue;
    }
    if (!("value" in descriptor)) {
      report(walk, child(path, index), "accessor");
      output.push(null);
      changed = true;
      continue;
    }
    // JSON.stringify writes a hidden element too; the copy makes it ordinary.
    if (!descriptor.enumerable) changed = true;
    const converted = convert(descriptor.value, child(path, index), depth + 1, walk);
    if (converted === OMIT) {
      // JSON writes an unrepresentable array element as null.
      if (descriptor.value === undefined) report(walk, child(path, index), "undefined");
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
  path: Path | null,
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
  let changed = walk.copy || forceCopy || (prototype !== Object.prototype && prototype !== null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") {
      report(walk, path, "symbol_key");
      changed = true;
      continue;
    }
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor)) {
      report(walk, child(path, key), "accessor");
      changed = true;
      continue;
    }
    if (!descriptor.enumerable) {
      report(walk, child(path, key), "hidden_property");
      changed = true;
      continue;
    }
    const converted = convert(descriptor.value, child(path, key), depth + 1, walk);
    if (converted === OMIT) {
      changed = true;
      continue;
    }
    defineData(output, key, converted.value);
    changed ||= converted.changed;
  }
  return changed ? { value: output, changed: true } : { value, changed: false };
}

function errorSummary(error: object, causes: number): Record<string, unknown> {
  const record = error as { name?: unknown; message?: unknown };
  const name = record.name;
  const message = record.message;
  const summary: Record<string, unknown> = {
    name: typeof name === "string" ? name : "Error",
    message: typeof message === "string" ? message : "",
  };
  for (const key of ["code", "status"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    const field = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (typeof field === "string" || (typeof field === "number" && Number.isFinite(field)))
      summary[key] = field;
  }
  const cause = Object.getOwnPropertyDescriptor(error, "cause");
  if (causes > 0 && cause && "value" in cause && cause.value && typeof cause.value === "object") {
    const brand = Object.prototype.toString.call(cause.value);
    if (isError(cause.value, brand)) summary.cause = errorSummary(cause.value, causes - 1);
  }
  return summary;
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

function isError(value: object, brand: string): boolean {
  const isErrorBrand = (Error as { isError?: (candidate: unknown) => boolean }).isError;
  return isErrorBrand ? isErrorBrand(value) : value instanceof Error || brand === "[object Error]";
}

/** A Map of any realm. */
function isMap(value: object): value is Map<unknown, unknown> {
  try {
    Map.prototype.has.call(value, undefined);
    return true;
  } catch {
    return false;
  }
}

/** A Set of any realm. */
function isSet(value: object): value is Set<unknown> {
  try {
    Set.prototype.has.call(value, undefined);
    return true;
  } catch {
    return false;
  }
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

// ---------------------------------------------------------------------------
// Logging adjustments without values or private keys
// ---------------------------------------------------------------------------

export type JsonSafeSummary = {
  count: number;
  kinds: Record<string, number>;
  /** The first few paths, with keys that may be data replaced by `[*]`. */
  paths: string[];
};

/**
 * Changes that lose nothing JSON can carry: an absent property, `-0`, and
 * request-local symbol-keyed marks. They are counted but never logged alone.
 */
const QUIET_KINDS: ReadonlySet<JsonSafeAdjustmentKind> = new Set([
  "undefined",
  "negative_zero",
  "symbol_key",
]);

/** Counts adjustments as they are reported, keeping only the first few paths. */
export function createJsonSafeSummary(maxPaths = 5): {
  onAdjustment: (adjustment: JsonSafeAdjustment) => void;
  /** The summary, or null when nothing worth logging was adjusted. */
  result: () => JsonSafeSummary | null;
} {
  const kinds: Record<string, number> = {};
  const paths: string[] = [];
  let count = 0;
  let loud = false;
  return {
    onAdjustment: (adjustment) => {
      count += 1;
      loud ||= !QUIET_KINDS.has(adjustment.kind);
      const key = adjustment.type ? `${adjustment.kind}:${adjustment.type}` : adjustment.kind;
      kinds[key] = (kinds[key] ?? 0) + 1;
      if (paths.length < maxPaths) paths.push(redactPath(adjustment.path));
    },
    result: () => (loud ? { count, kinds: { ...kinds }, paths: [...paths] } : null),
  };
}

/** Count adjustments by kind, for a compact log line. */
export function summarizeJsonSafeAdjustments(
  adjustments: readonly JsonSafeAdjustment[],
  maxPaths = 5,
): JsonSafeSummary {
  const kinds: Record<string, number> = {};
  for (const adjustment of adjustments) {
    const key = adjustment.type ? `${adjustment.kind}:${adjustment.type}` : adjustment.kind;
    kinds[key] = (kinds[key] ?? 0) + 1;
  }
  return {
    count: adjustments.length,
    kinds,
    paths: adjustments.slice(0, maxPaths).map(({ path }) => redactPath(path)),
  };
}

const PATH_SEGMENT = /\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/g;
const IDENTIFIER_KEY = /^[A-Za-z_$][\w$-]{0,40}$/;

/**
 * A path for a log line. Object keys are often data (an email address, a
 * file name, a user ID); only identifier-like keys and indices are kept.
 */
export function redactPath(path: string): string {
  const first = path.indexOf("[");
  const root = first === -1 ? path : path.slice(0, first);
  if (first === -1) return root.slice(0, 160);
  let redacted = root;
  for (const match of path.slice(first).matchAll(PATH_SEGMENT)) {
    if (match[1] !== undefined) {
      redacted += `[${match[1]}]`;
      continue;
    }
    let key: unknown;
    try {
      key = JSON.parse(match[2]!);
    } catch {
      key = undefined;
    }
    redacted += typeof key === "string" && IDENTIFIER_KEY.test(key) ? `[${match[2]}]` : "[*]";
    if (redacted.length > 160) return `${redacted.slice(0, 157)}...`;
  }
  return redacted;
}

/**
 * A warning for adjusted values, at most once a minute for the same message,
 * root path and kinds, so a value that is normalized at every checkpoint does
 * not flood the log. The suppressed count rides on the next line.
 */
export function createJsonSafeWarning(
  message: string,
  options: { intervalMs?: number; warn?: (message: string, detail: object) => void } = {},
): (context: Record<string, string>, summary: JsonSafeSummary) => void {
  const intervalMs = options.intervalMs ?? 60_000;
  const recent = new Map<string, { at: number; suppressed: number }>();
  return (context, summary) => {
    const key = `${Object.values(context).join("|")}|${Object.keys(summary.kinds).sort().join(",")}`;
    const now = Date.now();
    const last = recent.get(key);
    if (last && now - last.at < intervalMs) {
      last.suppressed += 1;
      return;
    }
    if (recent.size >= 1000) recent.clear();
    recent.set(key, { at: now, suppressed: 0 });
    const warn = options.warn ?? ((text: string, detail: object) => console.warn(text, detail));
    warn(message, {
      ...context,
      ...summary,
      ...(last && last.suppressed > 0 ? { suppressedSinceLast: last.suppressed } : {}),
    });
  };
}
