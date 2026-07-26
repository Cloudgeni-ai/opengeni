/**
 * Readable label for a tool call ("session_create" -> "session create").
 *
 * MCP tools are namespaced `<serverId>__<toolName>` (see prefixedMcpToolName),
 * and for catalog-imported servers that serverId is an opaque slug+hash.
 * De-slugging the whole thing leaked that id into the timeline; strip the
 * server prefix and show just the tool. Names without the `__` boundary (plain
 * built-ins like "session_create") are unaffected.
 */
export function toolDisplayName(name: string): string {
  // The prefix is a single LEFT boundary (`registryId__toolName`), so split on
  // the FIRST `__` — the tool name itself may contain `__` and must survive whole.
  const boundary = name.indexOf("__");
  const toolPart = boundary >= 0 ? name.slice(boundary + 2) : name;
  return toolPart.replace(/[_-]+/g, " ").trim();
}
