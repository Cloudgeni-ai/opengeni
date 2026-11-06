import type { Tool } from "@openai/agents";
import { descriptionPreview } from "./tool-discovery-ranking";

export function toolDescriptor(tool: Tool & { name: string }): {
  name: string;
  description: string;
} {
  const description =
    "description" in tool && typeof tool.description === "string" ? tool.description : "";
  // Share the existing tool_list preview, never summarize or alter a schema.
  return { name: tool.name, description: descriptionPreview(description, 160) };
}

/** A directory key is a filter over this pool, never an authorization identity. */
export function toolGroup(name: string, serverIds: ReadonlyMap<string, string>): string {
  const separator = name.lastIndexOf("__");
  const mappedSource = serverIds.get(name);
  const sourceId = mappedSource ?? (separator >= 0 ? name.slice(0, separator) : undefined);
  // Keep an opaque connection together, using a short display key and its
  // representative tool for context. Splitting it by every resource makes the
  // directory nearly as long as the tool list. Display keys are filters only;
  // even a short-key collision merely combines already-authorized tools.
  const connectionDigest = mappedSource?.match(/[a-f0-9]{16,}/i)?.[0];
  if (connectionDigest) return `connection/${connectionDigest.slice(0, 12)}`;
  // A bounded model-name hash without a source map cannot identify a connection.
  // Fall back to a readable resource, not one group per hashed tool name.
  const source = sourceId && !/[a-f0-9]{16,}/i.test(sourceId) ? sourceId : undefined;
  const local = separator >= 0 ? name.slice(separator + 2) : name;
  const parts = local.split("_");
  const operation = parts.findIndex((part) =>
    /^(get|read|list|search|find|create|update|save|delete|remove|set|add|archive|pause|resume|send|run|inspect|open|close|write|publish|export|import)$/.test(
      part,
    ),
  );
  const resource =
    operation > 0
      ? parts.slice(0, operation).join("_")
      : operation === 0
        ? source
          ? ""
          : parts[1]
        : parts[0];
  return source ? (resource ? `${source}/${resource}` : source) : resource || parts[0]!;
}

export function toolGroups(tools: (Tool & { name: string })[], groupOf: (name: string) => string) {
  const groups = new Map<
    string,
    { group: string; count: number; example: ReturnType<typeof toolDescriptor> }
  >();
  for (const tool of tools) {
    const group = groupOf(tool.name);
    const found = groups.get(group);
    if (found) found.count++;
    else groups.set(group, { group, count: 1, example: toolDescriptor(tool) });
  }
  return [...groups.values()].sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
}

/**
 * Tool families: tools of one server whose names share a resource prefix,
 * such as `checklists.create`, `checklists.list` and `checklists.archive`. A
 * family is shown with search results, lets a large connection's directory
 * group by resource, and loads whole with `names: ["checklists.*"]`.
 */
export const TOOL_FAMILY_POLICY = {
  /** The fewest tools a prefix needs to be a family. */
  minTools: 3,
  /** The most tools a family pattern loads at once. */
  maxLoad: 20,
  /** A connection with more tools than this lists its families as separate groups. */
  groupAbove: 40,
  /** The most families one search result names. */
  maxListed: 6,
  /** The fewest tools a family needs to be named beside search results. */
  listFrom: 5,
} as const;

export type ToolFamilyMember = {
  /** The model name. */
  name: string;
  /** Its server, when it has one: families never span servers. */
  server?: string;
  /** The name its server publishes, when that differs from the model name. */
  published?: string;
};

/** Words that name what a tool does rather than what it acts on. */
const OPERATION_PART =
  /^(get|read|list|search|find|create|update|save|delete|remove|set|add|archive|unarchive|pause|resume|send|run|inspect|open|close|write|publish|unpublish|export|import|by|all|new|apply|commit|duplicate|copy|move|preview|reorder|reset|toggle|link|unlink|attach|detach|assign|unassign|promote|approve|reject|submit|sign|start|stop|cancel|upload|download|generate|sync|validate|check|count|enable|disable|restore|mark|merge|split|capture|author|lock|unlock|share|invite|accept|decline|complete|reopen|refresh|clear|fetch|post|put|patch|batch|bulk)$/;

/** The name a family is read from: the published name, else the part after the server separator. */
const familyBase = (tool: ToolFamilyMember) => {
  if (tool.published) return tool.published;
  const separator = tool.name.lastIndexOf("__");
  return separator >= 0 ? tool.name.slice(separator + 2) : tool.name;
};

/** A name in the one spelling families compare: lowercase, dots and dashes as underscores. */
export const plainToolName = (name: string) => name.toLowerCase().replace(/[.\-/:]/g, "_");

/**
 * Each tool's family pattern (`checklists.*`, `job_safety_analyses_*`), for
 * tools that have one: a dotted name's part before its last dot, else the
 * longest underscore prefix at least {@link TOOL_FAMILY_POLICY.minTools}
 * tools of the same server begin, unless it is only operation words.
 */
export function toolFamilies(tools: readonly ToolFamilyMember[]): Map<string, string> {
  const families = new Map<string, string>();
  const patterns = new Map<string, string[]>();
  const byServer = new Map<string, ToolFamilyMember[]>();
  for (const tool of tools) {
    const server = tool.server ?? "";
    byServer.set(server, [...(byServer.get(server) ?? []), tool]);
  }
  for (const members of byServer.values()) {
    // Each tool's possible family prefixes; the longest prefix that enough
    // tools still without a family share wins, so `job_titles_list` does not
    // join `job_safety_analyses_*` as a `job_*` family.
    const prefixes = new Map<string, string[]>();
    for (const tool of members) {
      const base = familyBase(tool);
      const dot = base.lastIndexOf(".");
      const candidates =
        dot > 0
          ? [`${base.slice(0, dot)}.`]
          : base
              .split("_")
              .slice(0, -1)
              .map((_, index, parts) => `${parts.slice(0, index + 1).join("_")}_`)
              // A family names only its resource: `calculation_library_`,
              // not `calculation_library_preview_` or `list_`.
              .filter((prefix) =>
                prefix
                  .split("_")
                  .slice(0, -1)
                  .every((part) => !OPERATION_PART.test(part)),
              );
      for (const prefix of candidates) {
        const key = plainToolName(prefix);
        const entry = prefixes.get(key) ?? [];
        entry.push(tool.name);
        prefixes.set(key, entry);
      }
      patterns.set(tool.name, candidates);
    }
    for (const key of [...prefixes.keys()].sort(
      (a, b) => b.length - a.length || (a < b ? -1 : 1),
    )) {
      const free = prefixes.get(key)!.filter((name) => !families.has(name));
      if (free.length < TOOL_FAMILY_POLICY.minTools) continue;
      for (const name of free) {
        const pattern = patterns.get(name)!.find((prefix) => plainToolName(prefix) === key)!;
        families.set(name, `${pattern}*`);
      }
    }
  }
  return families;
}

/** The plain prefix a family pattern (`checklists.*`, `checklists_*`) loads, or undefined for an exact name. */
export function familyPrefix(entry: string): string | undefined {
  if (!entry.endsWith("*") || entry.includes("__")) return undefined;
  const prefix = plainToolName(entry.slice(0, -1).replace(/[_.\-/:]+$/, ""));
  return /[a-z0-9]/.test(prefix) ? `${prefix}_` : undefined;
}

/** The tools a family pattern denotes: those whose plain base name begins with its prefix. */
export function familyMembers(
  tools: readonly ToolFamilyMember[],
  prefix: string,
): ToolFamilyMember[] {
  return tools.filter((tool) => plainToolName(familyBase(tool)).startsWith(prefix));
}
