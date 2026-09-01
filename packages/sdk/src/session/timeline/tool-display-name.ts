/**
 * MCP / first-party tool naming helpers.
 *
 * Wire names are often `<serverId>__<toolName>` (see prefixedMcpToolName).
 * Matching and titles must use the leaf tool name so `opengeni__session_create`
 * and bare `session_create` resolve the same UI — without inventing previews
 * from argument JSON.
 */

/** Leaf tool name after the first `__` server boundary (or the whole name). */
export function mcpToolLeaf(name: string): string {
  const boundary = name.indexOf("__");
  return boundary >= 0 ? name.slice(boundary + 2) : name;
}

/**
 * True when `wireName` is exactly `leaf` or ends with `__${leaf}` (MCP prefix).
 * Does not treat arbitrary suffixes as matches — the leaf must be the full
 * right-hand side after `__`.
 */
export function toolMatchesLeaf(wireName: string, leaf: string): boolean {
  return wireName === leaf || wireName.endsWith(`__${leaf}`);
}

/**
 * Readable label for a tool call ("session_create" / "opengeni__session_create"
 * → "Session create"). Title-cases the first character of the leaf phrase.
 */
export function toolDisplayName(name: string): string {
  const phrase = mcpToolLeaf(name).replace(/[_-]+/g, " ").trim();
  if (!phrase) {
    return name;
  }
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
