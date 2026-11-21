import { createHash } from "node:crypto";
import {
  currentFirstPartyToolReference,
  firstPartyMcpToolAliasesOf,
  prefixedMcpToolName as plainPrefixedMcpToolName,
} from "@opengeni/contracts";

/**
 * MCP tool naming. Each tool has two names:
 *
 * - Its wire name, the function name the model calls: `<namespace>__<tool>`
 *   (mcpServerNamespace, mcpWireToolNames), at most 64 characters of
 *   `[A-Za-z0-9_]`, valid on every provider route. It depends only on the
 *   tool's identity (server, connected account, tool), never on the rest of
 *   the catalog, so a name in history never comes to mean another server's
 *   or another account's tool. Calls resolve only by it.
 * - Its reference name, the name anyone asks for it by: `server.tool`, or
 *   just `tool` when only one tool has that name (see mcpToolReferenceMatches).
 *   It has no length limit. tool_search `names`, Skill `tools:` lists and
 *   Codemode accept it; it never names the tool in a call the model writes.
 *
 * Opengeni's own servers (`opengeni`, `files`, `docs`) and Codex Apps keep
 * their `server__tool` names, so built-in tool names never change.
 */

/** Longest wire name every provider route accepts. */
export const MAX_WIRE_TOOL_NAME_LENGTH = 64;

const WIRE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Servers whose tools keep their `server__tool` names: Opengeni's own and Codex Apps. */
const SERVER_PREFIXED_REGISTRY_IDS: ReadonlySet<string> = new Set([
  "opengeni",
  "files",
  "docs",
  "codex_apps",
]);

/** Whether a server's tools keep their `server__tool` wire names. */
export function keepsServerPrefixedToolNames(registryId: string): boolean {
  return SERVER_PREFIXED_REGISTRY_IDS.has(registryId);
}

function shortDigest(registryId: string, toolName: string, length: number): string {
  return createHash("sha256")
    .update(JSON.stringify([registryId, toolName]))
    .digest("hex")
    .slice(0, length);
}

/**
 * The model name `server__tool` that Opengeni's own servers and Codex Apps
 * use. Before readable wire names every MCP tool was named this way, with a
 * name that would not fit shortened to `mcp_<digest>__<tool>`; see
 * isFormerMcpToolName.
 */
export function prefixedMcpToolName(registryId: string, toolName: string): string {
  const name = plainPrefixedMcpToolName(registryId, toolName);
  if (name.length <= MAX_WIRE_TOOL_NAME_LENGTH && /^[A-Za-z0-9_]+$/.test(name)) return name;
  const leaf = toolName.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 34) || "tool";
  return `mcp_${shortDigest(registryId, toolName, 24)}__${leaf}`;
}

/**
 * The names a tool had before readable wire names: `server__tool` or its
 * `mcp_<digest>__tool` alias (prefixedMcpToolName), and the bare 64-hex
 * digest of still earlier releases. Kept only so a call stored under one (a
 * call awaiting approval across a deploy) still reaches the same tool, and so
 * a model that calls one from older history is told the tool's current name.
 */
export function isFormerMcpToolName(registryId: string, toolName: string, name: string): boolean {
  return (
    name === prefixedMcpToolName(registryId, toolName) ||
    (/^[0-9a-f]{64}$/u.test(name) &&
      name ===
        createHash("sha256")
          .update(JSON.stringify([registryId, toolName]))
          .digest("hex"))
  );
}

/**
 * A name part as wire characters: anything outside `[A-Za-z0-9_]` becomes
 * `_`. Hyphens are valid on providers, but the SDK's function tools rewrite
 * them to `_`, so a name keeps the spelling it was allocated with only
 * without them.
 */
export function wireNamePart(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/** A readable, lowercase name for a server: letters, digits and single underscores. */
function serverSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24)
    .replace(/_+$/, "");
  if (!slug) return "mcp";
  return /^[a-z]/.test(slug) ? slug : `mcp_${slug}`;
}

/** A connected account's route id: `account-<sha256 of (server, connection)>` (mcpAccountRouteId). */
const ACCOUNT_ROUTE_ID = /^account-([0-9a-f]{64})$/u;

/** A registry id that is already a readable namespace. */
const SLUG_REGISTRY_ID = /^[A-Za-z][A-Za-z0-9_]{0,31}$/u;

export type McpServerNamespace = {
  /** The server's namespace: `gmail_3f2a1c`, or a configured server's id. */
  namespace: string;
  /** The namespace without its identity tag: `gmail`. Used only to ask for tools. */
  base: string;
};

/**
 * A server's namespace: the `server` in its tools' `<server>__<tool>` wire
 * names and Codemode paths. It depends only on the server's identity, never
 * on the other servers in the catalog, so a name never points at another
 * server or account in a later turn:
 *
 * - Opengeni's own servers and Codex Apps: their registry id.
 * - A connected account (`account-<digest of (server, connection)>`): the
 *   connector's readable name and the first 6 hex of that digest, such as
 *   `gmail_3f2a1c`. A replacement account of the same connector gets
 *   another tag, so it never inherits the old account's names.
 * - A configured server: its registry id when that is a readable slug,
 *   otherwise the slug of the id and 6 hex of its digest.
 */
export function mcpServerNamespace(
  registryId: string,
  connector?: string | undefined,
): McpServerNamespace {
  if (keepsServerPrefixedToolNames(registryId)) return { namespace: registryId, base: registryId };
  const account = ACCOUNT_ROUTE_ID.exec(registryId);
  if (account) {
    const base = serverSlug(connector ?? "account");
    return { namespace: `${base}_${account[1]!.slice(0, 6)}`, base };
  }
  if (SLUG_REGISTRY_ID.test(registryId)) return { namespace: registryId, base: registryId };
  const base = serverSlug(registryId);
  return { namespace: `${base}_${shortDigest(registryId, "", 6)}`, base };
}

/**
 * The wire name of each tool one server lists, by its published name. Every
 * tool is `<namespace>__<tool>` (Opengeni's own servers and Codex Apps keep
 * `server__tool`, prefixedMcpToolName). The name depends only on the server
 * and the tool, never on the rest of the catalog. A name over 64 characters
 * is shortened and ends in a digest of (server, tool); so does each of two
 * published names one server lists with one wire spelling (`a.b` and `a_b`),
 * which depends only on that server's own list.
 */
export function mcpWireToolNames(
  registryId: string,
  namespace: string,
  toolNames: readonly string[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const toolName of toolNames) {
    names.set(
      toolName,
      keepsServerPrefixedToolNames(registryId)
        ? prefixedMcpToolName(registryId, toolName)
        : boundedWireName(
            `${namespace}__${wireNamePart(toolName) || "tool"}`,
            registryId,
            toolName,
          ),
    );
  }
  const counts = new Map<string, number>();
  for (const name of names.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const [toolName, name] of names) {
    if (counts.get(name) === 1) continue;
    const suffix = `_${shortDigest(registryId, toolName, 8)}`;
    names.set(toolName, `${name.slice(0, MAX_WIRE_TOOL_NAME_LENGTH - suffix.length)}${suffix}`);
  }
  return names;
}

/** One tool's wire name (mcpWireToolNames) when its server lists no other name spelled the same. */
export function mcpToolWireName(
  registryId: string,
  toolName: string,
  connector?: string | undefined,
): string {
  const { namespace } = mcpServerNamespace(registryId, connector);
  return mcpWireToolNames(registryId, namespace, [toolName]).get(toolName)!;
}

function boundedWireName(name: string, registryId: string, toolName: string): string {
  if (name.length <= MAX_WIRE_TOOL_NAME_LENGTH) return name;
  const suffix = `_${shortDigest(registryId, toolName, 8)}`;
  return `${name.slice(0, MAX_WIRE_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
}

/** Whether `name` is a valid wire tool name on every provider route. */
export function isWireToolName(name: string): boolean {
  return WIRE_NAME.test(name);
}

/** A tool name with every separator (`.`, `-`, `_`, …) written as `_`. */
export function looseToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/gu, "_");
}

export type McpToolReference = {
  /** The tool's wire name. */
  wireName: string;
  /** Its server's namespace and base (mcpServerNamespace). */
  namespace: string;
  namespaceBase: string;
  registryId: string;
  /** Its name as its server publishes it. */
  toolName: string;
};

/**
 * Whether `name` refers to this tool: its wire name; `server.tool` or
 * `server__tool`, where server is its namespace, the namespace without an
 * account tag, or its registry id, and tool its published name or that name
 * in wire characters; or its plain published name. A plain name or a server
 * shared by several accounts can refer to several tools; the caller decides
 * what an ambiguous reference does.
 */
export function mcpToolReferenceMatches(tool: McpToolReference, name: string): boolean {
  if (mcpToolReferenceMatchesExactly(tool, name)) return true;
  // A first-party tool's hidden alias (its former name) still refers to it.
  if (tool.registryId !== "opengeni") return false;
  const current = currentFirstPartyToolReference(name);
  return current !== undefined && mcpToolReferenceMatchesExactly(tool, current);
}

/**
 * The current model name of a first-party tool called by its hidden alias:
 * `site_data_query` or `opengeni__site_data_query` give
 * `opengeni__app_data_query`. Undefined for any other name.
 */
export function firstPartyAliasModelToolName(name: string): string | undefined {
  const current = currentFirstPartyToolReference(name);
  if (current === undefined) return undefined;
  const separator = current.lastIndexOf("__");
  if (separator >= 0) return current.slice(0, separator) === "opengeni" ? current : undefined;
  return current.includes(".") ? undefined : `opengeni__${current}`;
}

/** The hidden aliases (former names) of a tool, as published names; usually none. */
export function mcpToolReferenceAliases(tool: McpToolReference): string[] {
  return tool.registryId === "opengeni" ? firstPartyMcpToolAliasesOf(tool.toolName) : [];
}

function mcpToolReferenceMatchesExactly(tool: McpToolReference, name: string): boolean {
  if (name === tool.wireName || name === tool.toolName) return true;
  // Agents write a published name's separators as `.`, `-` or `_` alike.
  const own = looseToolName(tool.toolName);
  if (looseToolName(name) === own) return true;
  for (const separator of [".", "__"]) {
    let at = name.indexOf(separator);
    while (at > 0) {
      const server = name.slice(0, at);
      const leaf = name.slice(at + separator.length);
      if (
        (leaf === tool.toolName || looseToolName(leaf) === own) &&
        (server === tool.namespace || server === tool.namespaceBase || server === tool.registryId)
      ) {
        return true;
      }
      at = name.indexOf(separator, at + 1);
    }
  }
  return false;
}
