import { hasPermission } from "@opengeni/core";
import {
  AUTOMATIC_SESSION_TITLE_FALLBACK,
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  mergeToolRefs,
  type FirstPartyMcpToolName,
  type Permission,
  type ToolRef,
} from "@opengeni/contracts";

export function shouldRequestMissingSessionTitle(input: {
  title: string | null;
  titleSource: "user" | "agent" | null;
  firstPartyMcpTools: readonly FirstPartyMcpToolName[];
  firstPartyMcpPermissions: readonly Permission[] | null;
}): boolean {
  const title = input.title?.trim() ?? "";
  const needsSemanticTitle =
    input.titleSource !== "user" && (!title || title === AUTOMATIC_SESSION_TITLE_FALLBACK);
  if (!needsSemanticTitle) return false;
  if (!input.firstPartyMcpTools.includes("set_session_title")) return false;
  const permissions = input.firstPartyMcpPermissions ?? DEFAULT_FIRST_PARTY_MCP_PERMISSIONS;
  return hasPermission([...permissions], "sessions:control");
}

/**
 * A title directive may name the tool directly only when its first-party MCP
 * server is present in the first provider request. Upgrade the already-selected
 * server to eager for title-needing turns without granting or attaching it.
 */
export function withEagerSessionTitleTool(
  tools: ToolRef[],
  shouldRequestTitle: boolean,
): ToolRef[] {
  if (!shouldRequestTitle || !tools.some((tool) => tool.kind === "mcp" && tool.id === "opengeni")) {
    return tools;
  }
  return mergeToolRefs(tools, [{ kind: "mcp", id: "opengeni", eager: true }]);
}
