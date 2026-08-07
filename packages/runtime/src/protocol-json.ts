const MAX_PROTOCOL_JSON_DEPTH = 512;

type NormalizeResult = { value: unknown; changed: boolean };

/**
 * Raised when an SDK value cannot be represented by the JSON protocol without
 * changing its meaning. The path identifies the exact offending value.
 */
export class UnsupportedProtocolJsonValueError extends TypeError {
  override readonly name = "UnsupportedProtocolJsonValueError";

  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`Protocol JSON value at ${path} ${detail}`);
  }
}

/**
 * Normalize a value received from a JavaScript SDK into protocol JSON.
 *
 * SDKs sometimes materialize an absent optional object property as an own
 * property whose value is `undefined`. JSON wire formats omit that property,
 * so this boundary does the same. Every other non-JSON value is rejected with
 * its path instead of being silently stringified, coerced, or replaced.
 * Inputs are never mutated; already-valid graphs retain their references.
 */
export function normalizeProtocolJsonValue<T>(value: T, rootPath = "$"): T {
  const normalized = normalizeValue(value, new Set<object>(), 0, rootPath);
  return normalized.value as T;
}

function normalizeValue(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
  path: string,
): NormalizeResult {
  if (depth > MAX_PROTOCOL_JSON_DEPTH) {
    throw new UnsupportedProtocolJsonValueError(
      path,
      `exceeds the maximum supported depth of ${MAX_PROTOCOL_JSON_DEPTH}`,
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { value, changed: false };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new UnsupportedProtocolJsonValueError(
        path,
        "must be a finite number other than negative zero",
      );
    }
    return { value, changed: false };
  }
  if (
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new UnsupportedProtocolJsonValueError(path, `cannot contain ${typeof value}`);
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new UnsupportedProtocolJsonValueError(path, "requires an array or plain object");
  }
  if (ancestors.has(value)) {
    throw new UnsupportedProtocolJsonValueError(path, "cannot contain a cyclic reference");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new UnsupportedProtocolJsonValueError(path, "cannot contain symbol keys");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return normalizeArray(value, ancestors, depth, path);
    }
    return normalizeObject(value, ancestors, depth, path);
  } finally {
    ancestors.delete(value);
  }
}

function normalizeArray(
  value: unknown[],
  ancestors: Set<object>,
  depth: number,
  path: string,
): NormalizeResult {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const indexNames = Object.getOwnPropertyNames(descriptors).filter((name) => name !== "length");
  if (
    indexNames.length !== value.length ||
    indexNames.some((name) => {
      const index = Number(name);
      return (
        !Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== name
      );
    })
  ) {
    throw new UnsupportedProtocolJsonValueError(
      path,
      "cannot contain array holes or non-index properties",
    );
  }

  const output: unknown[] = [];
  let changed = false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    const itemPath = `${path}[${index}]`;
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new UnsupportedProtocolJsonValueError(
        itemPath,
        "cannot be a hole, accessor, or hidden element",
      );
    }
    const normalized = normalizeValue(descriptor.value, ancestors, depth + 1, itemPath);
    output.push(normalized.value);
    changed ||= normalized.changed;
  }
  return changed ? { value: output, changed: true } : { value, changed: false };
}

function normalizeObject(
  value: Record<string, unknown>,
  ancestors: Set<object>,
  depth: number,
  path: string,
): NormalizeResult {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const prototype = Object.getPrototypeOf(value);
  const hasForeignObjectPrototype = prototype !== Object.prototype && prototype !== null;
  const output = Object.create(prototype === null ? null : Object.prototype) as Record<
    string,
    unknown
  >;
  let changed = hasForeignObjectPrototype;

  for (const [key, descriptor] of Object.entries(descriptors)) {
    const propertyPath = `${path}[${JSON.stringify(key)}]`;
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new UnsupportedProtocolJsonValueError(
        propertyPath,
        "cannot be an accessor or hidden property",
      );
    }
    if (typeof descriptor.value === "undefined") {
      changed = true;
      continue;
    }
    const normalized = normalizeValue(descriptor.value, ancestors, depth + 1, propertyPath);
    Object.defineProperty(output, key, {
      value: normalized.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    changed ||= normalized.changed;
  }

  return changed ? { value: output, changed: true } : { value, changed: false };
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) return true;

  // SDKs can return otherwise-plain JSON objects created in another JavaScript
  // realm (for example a VM-backed sandbox provider). Their Object.prototype
  // is not reference-equal to this realm's Object.prototype. Accept only the
  // foreign realm's native Object prototype; class instances still fail.
  if (Object.getPrototypeOf(prototype) !== null) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  return (
    typeof constructor === "function" &&
    constructor.name === "Object" &&
    Function.prototype.toString.call(constructor).includes("[native code]")
  );
}
