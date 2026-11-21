/**
 * Hidden former names of first-party tools. Dependency-free so the browser SDK
 * can bundle it (see packages/sdk/tsup.config.ts) and match a Site version that
 * still declares an old name; `./index` re-exports it.
 */

/**
 * Site tools renamed when Sites became apps. Unlike the retired names above,
 * each former name stays a callable hidden alias: the first-party server runs
 * it as its successor, Codemode and tool references resolve it, and a model
 * that calls it reaches the same tool. Only the new names are listed, so
 * agents only see them. Embedding products call these tools by name; keep
 * every entry until nobody uses the old name.
 */
export const FIRST_PARTY_MCP_TOOL_ALIASES = {
  site_data_describe: "app_data_describe",
  site_data_define_collection: "app_data_define_collection",
  site_data_query: "app_data_query",
  site_data_write: "app_data_write",
  site_data_import: "app_data_import",
  site_data_export: "app_data_export",
  site_data_reset: "app_data_reset",
  site_files_list: "app_files_list",
  site_files_upload: "app_files_upload",
  site_files_delete: "app_files_delete",
  site_publication_get: "app_publication_get",
  site_publication_update: "app_publication_update",
  site_publication_apply_fix: "app_publication_apply_fix",
  site_hostname_check: "app_hostname_check",
  site_sql_inspect: "app_sql_inspect",
  site_sql_enable: "app_sql_enable",
  site_sql_migrate: "app_sql_migrate",
  site_sql_define_query: "app_sql_define_query",
  site_sql_query: "app_sql_query",
  site_sql_run: "app_sql_run",
  site_sql_execute: "app_sql_execute",
  site_sql_export: "app_sql_export",
  site_sql_import: "app_sql_import",
  site_sql_reset: "app_sql_reset",
} as const;

/** The hidden former names in FIRST_PARTY_MCP_TOOL_ALIASES. */
export const FIRST_PARTY_MCP_TOOL_ALIAS_NAMES = Object.keys(
  FIRST_PARTY_MCP_TOOL_ALIASES,
) as (keyof typeof FIRST_PARTY_MCP_TOOL_ALIASES)[];
const firstPartyToolAliasNames = new Set<string>(FIRST_PARTY_MCP_TOOL_ALIAS_NAMES);

/**
 * The current first-party tool a hidden alias stands for, or undefined when
 * `name` is not an alias. Accepts any string so callers can check a name a
 * client sent before parsing it.
 */
export function firstPartyMcpToolAliasTarget(
  name: string,
): (typeof FIRST_PARTY_MCP_TOOL_ALIASES)[keyof typeof FIRST_PARTY_MCP_TOOL_ALIASES] | undefined {
  return firstPartyToolAliasNames.has(name)
    ? FIRST_PARTY_MCP_TOOL_ALIASES[name as keyof typeof FIRST_PARTY_MCP_TOOL_ALIASES]
    : undefined;
}

/** The hidden aliases of a current first-party tool (usually none). */
export function firstPartyMcpToolAliasesOf(name: string): string[] {
  return FIRST_PARTY_MCP_TOOL_ALIAS_NAMES.filter(
    (alias) => FIRST_PARTY_MCP_TOOL_ALIASES[alias] === name,
  );
}

/**
 * A reference to a first-party tool written with a hidden alias, rewritten to
 * the current name: `site_data_query`, `opengeni__site_data_query` or
 * `opengeni.site_data_query` become the same reference to `app_data_query`.
 * Undefined when the reference's last part is not an alias.
 */
export function currentFirstPartyToolReference(reference: string): string | undefined {
  const separator = reference.lastIndexOf("__");
  const dot = reference.lastIndexOf(".");
  const leafStart = Math.max(separator >= 0 ? separator + 2 : 0, dot >= 0 ? dot + 1 : 0);
  const target = firstPartyMcpToolAliasTarget(reference.slice(leafStart));
  return target === undefined ? undefined : `${reference.slice(0, leafStart)}${target}`;
}

/**
 * A tool identity naming a first-party tool by a hidden alias, with the
 * current name; any other identity unchanged. Server `opengeni` only.
 */
export function currentFirstPartyToolIdentity<T extends { serverId: string; toolName: string }>(
  identity: T,
): T {
  if (identity.serverId !== "opengeni") return identity;
  const target = firstPartyMcpToolAliasTarget(identity.toolName);
  return target === undefined ? identity : { ...identity, toolName: target };
}
