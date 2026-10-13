import type { ErrorObject, ValidateFunction } from "ajv";

/**
 * Models often send a value as JSON text instead of the value itself: a number
 * as "5", or a nested object or array as '{"kind":"click"}'. JSON Schema
 * validation rightly rejects that, and Ajv's `coerceTypes` would also turn
 * booleans, nulls and arrays into each other. This repair is deliberately
 * narrower. It only rewrites a string at a location the schema reported as
 * needing an `integer` or `number` (when the whole string is a plain decimal
 * literal of that kind) or an `object` or `array` (when the whole string is
 * JSON text of exactly that type). Decoded values can contain the same
 * mistakes, so the repair runs a few bounded passes. The caller uses the
 * repaired call only if it then passes the original validator, and otherwise
 * reports the remaining problems against it. Everything else is rejected as
 * before.
 */
const INTEGER_LITERAL = /^-?(?:0|[1-9]\d*)$/u;
const NUMBER_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
const MAX_REPAIR_PASSES = 4;

export function repairStringEncodedArguments<Args extends Record<string, unknown>>(
  args: Args,
  diagnose: ValidateFunction<unknown>,
): Args | undefined {
  let current = args;
  let changed = false;
  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass += 1) {
    if (diagnose(current)) break;
    const replacements = new Map<string, unknown>();
    for (const error of diagnose.errors ?? []) {
      const replacement = stringReplacement(current, error);
      if (replacement === NO_REPLACEMENT) continue;
      replacements.set(error.instancePath, replacement);
    }
    if (replacements.size === 0) break;
    const repaired = structuredClone(current);
    for (const [pointer, value] of replacements) {
      if (!setAtPointer(repaired, pointer, value)) return undefined;
    }
    current = repaired;
    changed = true;
  }
  return changed ? current : undefined;
}

const NO_REPLACEMENT = Symbol("no replacement");

function stringReplacement(
  args: Record<string, unknown>,
  error: ErrorObject,
): unknown | typeof NO_REPLACEMENT {
  if (error.keyword !== "type" || error.instancePath === "") return NO_REPLACEMENT;
  const expected = String((error.params as { type?: unknown }).type ?? "").split(",");
  const current = getAtPointer(args, error.instancePath);
  if (typeof current !== "string") return NO_REPLACEMENT;
  const numeric = numericReplacement(current, expected);
  if (numeric !== undefined) return numeric;
  return structuredReplacement(current, expected);
}

function numericReplacement(current: string, expected: string[]): number | undefined {
  const wantsInteger = expected.includes("integer");
  const wantsNumber = expected.includes("number");
  if (!wantsInteger && !wantsNumber) return undefined;
  if (wantsNumber ? !NUMBER_LITERAL.test(current) : !INTEGER_LITERAL.test(current)) {
    return undefined;
  }
  const value = Number(current);
  if (!Number.isFinite(value)) return undefined;
  if (!wantsNumber && !Number.isSafeInteger(value)) return undefined;
  return value;
}

function structuredReplacement(
  current: string,
  expected: string[],
): unknown | typeof NO_REPLACEMENT {
  const wantsObject = expected.includes("object");
  const wantsArray = expected.includes("array");
  if (!wantsObject && !wantsArray) return NO_REPLACEMENT;
  const text = current.trim();
  if (!(wantsObject && text.startsWith("{")) && !(wantsArray && text.startsWith("["))) {
    return NO_REPLACEMENT;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return NO_REPLACEMENT;
  }
  if (Array.isArray(value)) return wantsArray ? value : NO_REPLACEMENT;
  if (value !== null && typeof value === "object") return wantsObject ? value : NO_REPLACEMENT;
  return NO_REPLACEMENT;
}

function pointerSegments(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

function getAtPointer(root: unknown, pointer: string): unknown {
  let current: unknown = root;
  for (const segment of pointerSegments(pointer)) {
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function setAtPointer(root: unknown, pointer: string, value: unknown): boolean {
  const segments = pointerSegments(pointer);
  const last = segments.pop();
  if (last === undefined) return false;
  let parent: unknown = root;
  for (const segment of segments) {
    if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, segment)) {
      return false;
    }
    parent = (parent as Record<string, unknown>)[segment];
  }
  if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, last)) return false;
  (parent as Record<string, unknown>)[last] = value;
  return true;
}
