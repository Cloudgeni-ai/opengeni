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

export function toolGroups(
  tools: (Tool & { name: string })[],
  serverIds: ReadonlyMap<string, string>,
) {
  const groups = new Map<
    string,
    { group: string; count: number; example: ReturnType<typeof toolDescriptor> }
  >();
  for (const tool of tools) {
    const group = toolGroup(tool.name, serverIds);
    const found = groups.get(group);
    if (found) found.count++;
    else groups.set(group, { group, count: 1, example: toolDescriptor(tool) });
  }
  return [...groups.values()].sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
}
