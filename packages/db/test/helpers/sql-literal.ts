/**
 * Render one bound query parameter as a SQL literal for `EXECUTE name(...)` in
 * plan tests. Arrays become array literals, so id lists bound as one array
 * parameter keep their element values; the prepared statement supplies types.
 */
export function sqlParameterLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) {
    const elements = value.map((element) =>
      element === null || element === undefined
        ? "NULL"
        : `"${String(element).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    );
    return `'{${elements.join(",").replaceAll("'", "''")}}'`;
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}
