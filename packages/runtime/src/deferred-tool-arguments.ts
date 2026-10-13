/**
 * Restore JSON value types on a direct call to a search-disclosed tool.
 *
 * With generic progressive disclosure, deferred tool schemas stay off the
 * provider request so the cached prefix stays stable; the model learns them
 * from tool_search and may then call the tool by its exact name. Some
 * providers decode the parameters of a tool they were never sent as plain
 * strings, so `{"limit": 3}` arrives as `{"limit": "3"}` and an array or
 * object arrives as its JSON text. The gateway then rejects the call with
 * "must be integer" / "must be array" even though the model's intent was exact.
 *
 * This only rewrites a string value whose schema does not allow a string and
 * whose JSON text parses to a value of an allowed type. Anything else is left
 * unchanged for the normal schema validation to accept or reject.
 */

type JsonSchema = Record<string, unknown>;

const NON_STRING_TYPES = new Set(["integer", "number", "boolean", "null", "array", "object"]);
const MAX_DEPTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFiniteJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown) => {
    // JSON.parse accepts overflowing numeric literals, but JSON.stringify
    // silently turns their Infinity values into null, even in nested containers.
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Non-finite JSON number");
    }
    return value;
  });
}

/** Declared JSON types of a schema, including simple anyOf/oneOf unions; null when unknown. */
function declaredTypes(schema: unknown, depth = 0): Set<string> | null {
  if (!isRecord(schema) || depth > MAX_DEPTH) return null;
  const types = new Set<string>();
  const type = schema.type;
  if (typeof type === "string") types.add(type);
  else if (Array.isArray(type)) for (const t of type) if (typeof t === "string") types.add(t);
  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = schema[key];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      const nested = declaredTypes(variant, depth + 1);
      if (!nested) return null;
      for (const t of nested) types.add(t);
    }
  }
  if ("const" in schema || "enum" in schema) {
    const values = "const" in schema ? [schema.const] : schema.enum;
    if (Array.isArray(values)) for (const v of values) types.add(jsonType(v));
  }
  return types.size > 0 ? types : null;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesAny(value: unknown, types: Set<string>): boolean {
  const actual = jsonType(value);
  if (types.has(actual)) return true;
  return actual === "integer" && types.has("number");
}

function coerceValue(value: unknown, schema: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === "string") {
    const types = declaredTypes(schema);
    if (!types || types.has("string") || ![...types].some((t) => NON_STRING_TYPES.has(t))) {
      return value;
    }
    let parsed: unknown;
    try {
      parsed = parseFiniteJson(value);
    } catch {
      return value;
    }
    if (!matchesAny(parsed, types)) return value;
    value = parsed;
  }
  if (isRecord(value)) return coerceObject(value, schema, depth);
  if (Array.isArray(value)) {
    const items = childSchema(schema, null, depth);
    if (items === undefined || items === FORBIDDEN) return value;
    let changed = false;
    const next = value.map((item) => {
      const coerced = coerceValue(item, items, depth + 1);
      changed ||= coerced !== item;
      return coerced;
    });
    return changed ? next : value;
  }
  return value;
}

const FORBIDDEN = Symbol("property forbidden by this alternative");

/** Resolve only declared child types without flattening platform constraints.
 * A permissive alternative or a string-typed alternative must retain text.
 * An alternative forbidding a key cannot admit it and contributes no type.
 * The original schema still validates the entire restored call afterwards. */
function childSchema(schema: unknown, key: string | null, depth: number): unknown {
  if (!isRecord(schema) || depth > MAX_DEPTH) return undefined;
  if (key === null) {
    if (isRecord(schema.items)) return schema.items;
  } else if (isRecord(schema.properties) && Object.hasOwn(schema.properties, key)) {
    return schema.properties[key];
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const variants = schema[keyword];
    if (!Array.isArray(variants)) continue;
    const children: unknown[] = [];
    for (const variant of variants) {
      const child = childSchema(variant, key, depth + 1);
      if (child === undefined) return undefined;
      if (child !== FORBIDDEN) children.push(child);
    }
    return children.length > 0 ? { anyOf: children } : FORBIDDEN;
  }
  return key !== null && schema.additionalProperties === false ? FORBIDDEN : undefined;
}

function coerceObject(
  value: Record<string, unknown>,
  schema: unknown,
  depth: number,
): Record<string, unknown> {
  if (!isRecord(schema) || depth > MAX_DEPTH) return value;
  let changed = false;
  // Unknown own keys must survive for downstream validation. In particular,
  // assigning __proto__ to a normal object would invoke its inherited setter.
  const next: Record<string, unknown> = Object.create(null);
  for (const [key, current] of Object.entries(value)) {
    const child = childSchema(schema, key, depth);
    const coerced =
      child === undefined || child === FORBIDDEN ? current : coerceValue(current, child, depth + 1);
    changed ||= coerced !== current;
    next[key] = coerced;
  }
  return changed ? next : value;
}

/**
 * Returns the corrected JSON argument text, or null when nothing changed or the
 * arguments are not a JSON object.
 */
export function restoreDeferredToolArgumentTypes(
  argumentsText: string,
  parameters: JsonSchema | undefined,
): string | null {
  if (!parameters) return null;
  let parsed: unknown;
  try {
    parsed = parseFiniteJson(argumentsText);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const coerced = coerceObject(parsed, parameters, 0);
  return coerced === parsed ? null : JSON.stringify(coerced);
}
