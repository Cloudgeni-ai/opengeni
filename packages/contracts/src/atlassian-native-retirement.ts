/** The former API/Knowledge-sync adapter is historical; hosted Atlassian MCP remains supported. */
export const ATLASSIAN_NATIVE_RETIRED_REASON = "atlassian_native_retired" as const;
export const ATLASSIAN_NATIVE_RETIRED_MESSAGE =
  "Jira and Confluence knowledge sync has been retired. Connect Atlassian agent tools to use its hosted MCP server.";
export const RETIRED_NATIVE_ATLASSIAN_TOOL_NAMES = [
  "atlassian_sources_list",
  "atlassian_search",
  "atlassian_get",
] as const;

export function isRetiredNativeAtlassianTool(name: string): boolean {
  return (RETIRED_NATIVE_ATLASSIAN_TOOL_NAMES as readonly string[]).includes(name);
}

/** Match the native source identity, never the hosted MCP provider or a display name. */
export function isRetiredNativeAtlassianSource(source: unknown): boolean {
  if (!source || typeof source !== "object") return false;
  const connection = (source as { connection?: unknown }).connection;
  if (!connection || typeof connection !== "object") return false;
  const provider = (connection as { providerDomain?: unknown }).providerDomain;
  return typeof provider === "string" && provider.toLowerCase() === "api.atlassian.com";
}

/** Includes frozen historical source actions without changing their stored bytes. */
export function isRetiredNativeAtlassianTask(task: {
  agentConfig?: { knowledgeSource?: unknown } | null;
  action?: { kind?: unknown } | null;
}): boolean {
  return (
    isRetiredNativeAtlassianSource(task.agentConfig?.knowledgeSource) ||
    (task.action?.kind === "knowledge_source_sync" && isRetiredNativeAtlassianSource(task.action))
  );
}
