import { isRecord } from "@opengeni/contracts/values";
import { TOOL_DISCLOSURE_KEY, toolDisclosureItem } from "./provider-history-adapter";

/** Records a generic search's result (and, from version 2, its loaded definitions) on the call. */
export const SEARCH_MARKER_KEY = "opengeni.lazy_search.v1";
/** Frozen companion schemas an entry-tool call disclosed, kept on the call itself. */
export const FAMILY_DISCLOSURE_MARKER_KEY = "opengeni.family_disclosure.v1";
/** Call id prefix of the internal search pair that registers generic dispatch tools. */
export const INTERNAL_DISPATCH_REGISTRATION_CALL_PREFIX = "opengeni:lazy-dispatch:register:";
/**
 * Marks the tool disclosure a compaction carries over: the tools loaded before
 * the checkpoint that the conversation still uses. It is a stored history item,
 * unlike the request-local disclosures an entry-tool call produces.
 */
export const CARRIED_TOOL_DISCLOSURE_KEY = "opengeni.carried_tool_disclosure.v1";

type CarriedToolDisclosureMarker = {
  version: 1;
  /** Whether the definitions were loaded on a generic (tool_invoke) route. */
  viaToolInvoke: boolean;
};

/** Searches load tools; calling them is not a use of a loaded tool. */
const SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(["tool_search", "tool_list"]);
/** Model-issued calls other than function calls; each ends "loaded but not yet used". */
const OTHER_CALL_TYPES: ReadonlySet<string> = new Set([
  "shell_call",
  "local_shell_call",
  "computer_call",
  "apply_patch_call",
]);

function callId(candidate: Record<string, unknown>): string | null {
  if (typeof candidate.callId === "string") return candidate.callId;
  if (typeof candidate.call_id === "string") return candidate.call_id;
  const providerData = isRecord(candidate.providerData) ? candidate.providerData : null;
  return providerData && typeof providerData.call_id === "string" ? providerData.call_id : null;
}

function providerDataOf(candidate: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(candidate.providerData) ? candidate.providerData : null;
}

function toolDefinitions(tools: unknown): Record<string, unknown>[] {
  if (!Array.isArray(tools)) return [];
  return tools.filter(
    (tool): tool is Record<string, unknown> =>
      isRecord(tool) &&
      typeof tool.name === "string" &&
      tool.name.length > 0 &&
      (tool.type === undefined || tool.type === "function"),
  );
}

function carriedMarker(candidate: Record<string, unknown>): CarriedToolDisclosureMarker | null {
  if (candidate.type !== "message" || candidate.role !== "developer") return null;
  const marker = providerDataOf(candidate)?.[CARRIED_TOOL_DISCLOSURE_KEY];
  if (!isRecord(marker) || marker.version !== 1) return null;
  return { version: 1, viaToolInvoke: marker.viaToolInvoke === true };
}

/** True for the tool disclosure an earlier compaction stored. */
export function isCarriedToolDisclosure(item: unknown): boolean {
  return isRecord(item) && carriedMarker(item) !== null;
}

function carriedTools(candidate: Record<string, unknown>): Record<string, unknown>[] {
  const disclosure = providerDataOf(candidate)?.[TOOL_DISCLOSURE_KEY];
  return isRecord(disclosure) ? toolDefinitions(disclosure.tools) : [];
}

/** Definitions a legacy (version 1) generic search result carried in its output text. */
function legacyGenericSearchDefinitions(output: string): Record<string, unknown>[] {
  try {
    const parsed: unknown = JSON.parse(output);
    // Compact candidate descriptors (schemasLoaded present) are not disclosures.
    return isRecord(parsed) && parsed.schemasLoaded === undefined
      ? toolDefinitions(parsed.tools)
      : [];
  } catch {
    return [];
  }
}

/**
 * The tool disclosure a compaction stores in the history it rebuilds, so tools
 * the model loaded before the checkpoint and still uses stay loaded after it,
 * or undefined when there are none.
 *
 * Loaded tools are found in the order the history disclosed them: native
 * search results, generic search results, entry-tool family disclosures and
 * an earlier compaction's carried disclosure. Each keeps the newest frozen
 * definition the history holds; nothing is read from the live catalog.
 *
 * A tool is carried when it was called after it was loaded, or when the model
 * has called no tool since loading it (a compaction right after a search keeps
 * what the search just loaded). A tool that was loaded and then passed over is
 * left out: it can be searched for again, and repeated compactions do not
 * accumulate schemas nobody uses.
 *
 * The item is the provider-neutral tool disclosure every projection already
 * renders (Codex `additional_tools`, otherwise a developer or system message),
 * built only from the items it replaces, so it changes no earlier request.
 */
export function carriedToolDisclosureItem(
  items: readonly unknown[],
): Record<string, unknown> | undefined {
  const definitions = new Map<string, Record<string, unknown>>();
  const called = new Set<string>();
  // Loaded since the model last called a tool.
  let unused = new Set<string>();
  const pending = new Map<string, { tools: Record<string, unknown>[]; viaToolInvoke: boolean }>();
  let viaToolInvoke = false;
  const disclose = (tools: Record<string, unknown>[], generic: boolean) => {
    if (tools.length === 0) return;
    for (const tool of tools) {
      const name = String(tool.name);
      definitions.set(name, tool);
      unused.add(name);
    }
    viaToolInvoke = generic;
  };
  const use = (name: string | null) => {
    if (name !== null && SEARCH_TOOL_NAMES.has(name)) return;
    if (name !== null && definitions.has(name)) called.add(name);
    unused = new Set();
  };
  for (const candidate of items) {
    if (!isRecord(candidate)) continue;
    const earlier = carriedMarker(candidate);
    if (earlier) {
      disclose(carriedTools(candidate), earlier.viaToolInvoke);
      continue;
    }
    if (candidate.type === "tool_search_output") {
      const id = callId(candidate);
      if (id?.startsWith(INTERNAL_DISPATCH_REGISTRATION_CALL_PREFIX)) continue;
      disclose(toolDefinitions(candidate.tools), false);
      continue;
    }
    if (typeof candidate.type === "string" && OTHER_CALL_TYPES.has(candidate.type)) {
      use(null);
      continue;
    }
    if (candidate.type === "function_call") {
      use(typeof candidate.name === "string" ? candidate.name : null);
      const providerData = providerDataOf(candidate);
      const id = callId(candidate);
      const search = providerData?.[SEARCH_MARKER_KEY];
      if (id && isRecord(search) && typeof search.output === "string") {
        const tools =
          search.version === 2
            ? toolDefinitions(search.tools)
            : search.version === 1
              ? legacyGenericSearchDefinitions(search.output)
              : [];
        if (tools.length > 0) pending.set(id, { tools, viaToolInvoke: true });
      }
      const family = providerData?.[FAMILY_DISCLOSURE_MARKER_KEY];
      if (id && isRecord(family) && family.version === 1) {
        const tools = toolDefinitions(family.tools);
        if (tools.length > 0)
          pending.set(id, { tools, viaToolInvoke: family.viaToolInvoke === true });
      }
      continue;
    }
    if (candidate.type === "function_call_result") {
      const id = callId(candidate);
      const loaded = id ? pending.get(id) : undefined;
      if (!id || !loaded) continue;
      pending.delete(id);
      disclose(loaded.tools, loaded.viaToolInvoke);
    }
  }
  const tools = [...definitions].flatMap(([name, tool]) =>
    called.has(name) || unused.has(name) ? [tool] : [],
  );
  if (tools.length === 0) return undefined;
  const item = toolDisclosureItem(tools, { viaToolInvoke });
  return {
    ...item,
    providerData: {
      ...(item.providerData as Record<string, unknown>),
      [CARRIED_TOOL_DISCLOSURE_KEY]: {
        version: 1,
        viaToolInvoke,
      } satisfies CarriedToolDisclosureMarker,
    },
  };
}
