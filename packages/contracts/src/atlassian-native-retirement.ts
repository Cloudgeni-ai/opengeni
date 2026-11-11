/**
 * Tool names of the removed native Atlassian adapter. They stay in the public
 * first-party tool enum until the next SDK major, so callers hide them;
 * hosted Atlassian MCP is the supported integration.
 */
export const RETIRED_NATIVE_ATLASSIAN_TOOL_NAMES = [
  "atlassian_sources_list",
  "atlassian_search",
  "atlassian_get",
] as const;

export function isRetiredNativeAtlassianTool(name: string): boolean {
  return (RETIRED_NATIVE_ATLASSIAN_TOOL_NAMES as readonly string[]).includes(name);
}
