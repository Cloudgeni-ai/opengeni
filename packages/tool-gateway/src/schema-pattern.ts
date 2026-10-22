/** Ajv's `RegExpLike` and `RegExpEngine` (not re-exported from its root). */
type RegExpLike = { test: (value: string) => boolean };
type RegExpEngine = ((pattern: string, flags: string) => RegExpLike) & { code: string };

/** Stands in for a pattern no JavaScript regex syntax accepts: not enforced. */
const UNENFORCED_PATTERN: RegExpLike = { test: () => true };

/**
 * Compile a JSON Schema `pattern` (or `patternProperties` key) from a tool
 * definition. Remote tool servers often write patterns that are valid
 * ECMAScript but not in Unicode mode, such as `\-` or `\#` outside a character
 * class. Use Unicode semantics when the pattern allows it, else ordinary
 * ECMAScript semantics. A pattern neither accepts is not enforced here, rather
 * than failing every call to the server's tools; the server still validates
 * its own input.
 */
export function compileSchemaPattern(pattern: string, flags: string): RegExpLike {
  try {
    return new RegExp(pattern, flags);
  } catch {
    // Retried below without Unicode mode.
  }
  if (flags.includes("u")) {
    try {
      return new RegExp(pattern, flags.replaceAll("u", ""));
    } catch {
      // Neither syntax accepts it.
    }
  }
  return UNENFORCED_PATTERN;
}

/** Ajv's `code.regExp` engine for tool schemas. */
export const schemaPatternEngine: RegExpEngine = Object.assign(
  (pattern: string, flags: string) => compileSchemaPattern(pattern, flags),
  { code: "compileSchemaPattern" },
);
