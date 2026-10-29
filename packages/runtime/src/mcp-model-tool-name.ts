import { createHash } from "node:crypto";
import { prefixedMcpToolName as plainPrefixedMcpToolName } from "@opengeni/contracts";

/** Longest name part an aliased MCP model name keeps after its digest. */
export const ALIASED_MCP_TOOL_LEAF_LENGTH = 34;

/** An aliased model name: `mcp_<24 hex digest>__<sanitized, bounded original name>`. */
const ALIASED_MCP_TOOL_NAME = /^mcp_[0-9a-f]{24}__/;

/**
 * The model name of one server's MCP tool. A registry ID and tool name that
 * already form a valid function name are joined; anything else (punctuation
 * such as "projects.search", a hyphenated registry ID, or more than 64
 * characters) becomes a readable alias.
 */
export function prefixedMcpToolName(registryId: string, toolName: string): string {
  const name = plainPrefixedMcpToolName(registryId, toolName);
  if (name.length <= 64 && /^[A-Za-z0-9_]+$/.test(name)) return name;
  // This is a readable wire alias, never account or execution authority. The
  // exact tuple stays in the catalog and duplicate aliases fail closed there.
  // Hash the full tuple before bounding the leaf so long/punctuation-equivalent
  // names cannot silently select a different tool.
  const digest = legacyMcpToolDigest(registryId, toolName).slice(0, 24);
  const leaf =
    toolName.replace(/[^A-Za-z0-9_]/g, "_").slice(0, ALIASED_MCP_TOOL_LEAF_LENGTH) || "tool";
  return `mcp_${digest}__${leaf}`;
}

export function legacyMcpToolDigest(registryId: string, toolName: string): string {
  return createHash("sha256")
    .update(JSON.stringify([registryId, toolName]))
    .digest("hex");
}

/** Whether a model tool name is an alias whose name part may be sanitized and bounded. */
export function isAliasedMcpToolName(name: string): boolean {
  return ALIASED_MCP_TOOL_NAME.test(name);
}
