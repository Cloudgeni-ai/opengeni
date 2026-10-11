import type { ErrorObject, ValidateFunction } from "ajv";

/**
 * Models often send a number as a JSON string ("5" for 5). JSON Schema
 * validation rightly rejects that, and Ajv's `coerceTypes` would also turn
 * booleans, nulls and arrays into each other. This repair is deliberately
 * narrower: it only rewrites a string at a location the schema reported as
 * needing an `integer` or `number`, only when the whole string is a plain
 * decimal literal of that kind. The caller uses the repaired call only if it
 * then passes the original validator, and otherwise reports the remaining
 * problems against it. Everything else is rejected as before.
 */
const INTEGER_LITERAL = /^-?(?:0|[1-9]\d*)$/u;
const NUMBER_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

export function repairNumericStringArguments<Args extends Record<string, unknown>>(
  args: Args,
  diagnose: ValidateFunction<unknown>,
): Args | undefined {
  if (diagnose(args)) return undefined;
  const replacements = new Map<string, number>();
  for (const error of diagnose.errors ?? []) {
    const replacement = numericReplacement(args, error);
    if (replacement === undefined) continue;
    replacements.set(error.instancePath, replacement);
  }
  if (replacements.size === 0) return undefined;
  const repaired = structuredClone(args);
  for (const [pointer, value] of replacements) {
    if (!setAtPointer(repaired, pointer, value)) return undefined;
  }
  return repaired;
}

function numericReplacement(args: Record<string, unknown>, error: ErrorObject): number | undefined {
  if (error.keyword !== "type" || error.instancePath === "") return undefined;
  const expected = String((error.params as { type?: unknown }).type ?? "").split(",");
  const wantsInteger = expected.includes("integer");
  const wantsNumber = expected.includes("number");
  if (!wantsInteger && !wantsNumber) return undefined;
  const current = getAtPointer(args, error.instancePath);
  if (typeof current !== "string") return undefined;
  if (wantsNumber ? !NUMBER_LITERAL.test(current) : !INTEGER_LITERAL.test(current)) {
    return undefined;
  }
  const value = Number(current);
  if (!Number.isFinite(value)) return undefined;
  if (!wantsNumber && !Number.isSafeInteger(value)) return undefined;
  return value;
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

function setAtPointer(root: unknown, pointer: string, value: number): boolean {
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
