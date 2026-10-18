/**
 * MCP / first-party tool naming helpers.
 *
 * Wire names are often `<serverId>__<toolName>` (see prefixedMcpToolName).
 * Matching and titles must use the leaf tool name so `opengeni__session_create`
 * and bare `session_create` resolve the same UI — without inventing previews
 * from argument JSON.
 */

import type { ToolDisplayMetadata } from "@opengeni/sdk";
import { type OpenGeniText } from "../messages/runtime";

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
 * Platform tools whose wire names describe plumbing, not what the person sees
 * happen ("Tool list", "Sandbox file publish"). These read as plain steps.
 */
const PLAIN_PLATFORM_TOOL_TITLES = {
  tool_list: "timeline.toolPresentation.lookedUpTools",
  sandbox_file_publish: "timeline.toolDisplayName.publishFile",
} as const;

/**
 * Readable label for a tool call ("session_create" / "opengeni__session_create"
 * → "Session create"). Title-cases the first character of the leaf phrase. A
 * connector account is named only when the connector has several ("List
 * issues · alice@example.com"); the connector itself shows as its logo.
 */
export function toolDisplayName(
  t: OpenGeniText,
  name: string,
  display?: ToolDisplayMetadata,
): string {
  if (!display && /^[a-f0-9]{64}$/.test(name)) return t("timeline.toolDisplayName.toolCall");
  if (!display?.connector) {
    const leaf = mcpToolLeaf(name);
    if (Object.hasOwn(PLAIN_PLATFORM_TOOL_TITLES, leaf)) {
      return t(PLAIN_PLATFORM_TOOL_TITLES[leaf as keyof typeof PLAIN_PLATFORM_TOOL_TITLES]);
    }
  }
  // "batch modify messages" → "Modify messages": batching is transport, not the action.
  const phrase = (display?.toolName ?? mcpToolLeaf(name))
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/^batch\s+(?=\S)/i, "");
  const title =
    display?.title ?? (phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : name);
  // Older events carry the full "Connector — Personal: account · Only me" route
  // label for every account route without saying whether there were several.
  // The tool name alone reads better than that.
  if (!display?.connector) return title;
  return display.accountLabel ? `${title} · ${display.accountLabel}` : title;
}
