/** A routing hint built only from the current authorized deferred tool pool. */
export type ToolGroupDescriptor = { name: string; description: string };

export const TOOL_GROUP_DIRECTORY_MAX_BYTES = 4 * 1024;

/** Namespaces use __; unnamespaced runtime tools share their first word prefix. */
function groupPrefix(name: string): string {
  const namespaceEnd = name.lastIndexOf("__");
  if (namespaceEnd >= 0) return name.slice(0, namespaceEnd + 2);
  const wordEnd = name.indexOf("_");
  return wordEnd >= 0 ? name.slice(0, wordEnd + 1) : name;
}

export function renderToolGroupDirectory(
  tools: readonly ToolGroupDescriptor[],
  preparationPending: boolean,
): string {
  if (tools.length === 0 && !preparationPending) return "";
  const groups = new Map<string, ToolGroupDescriptor>();
  for (const tool of tools) {
    const prefix = groupPrefix(tool.name);
    const example = groups.get(prefix);
    if (!example || tool.name < example.name) groups.set(prefix, tool);
  }
  const header = [
    "Available deferred tool groups (routing hints, not additional permissions):",
    "Use tool_list({namePrefix: <prefix>}) to browse a group; follow nextCursor until null. Use tool_search({query: '', names: [<exact name>]}) to load selected schemas, or search by capability.",
    "Each entry gives a literal namePrefix and one example (not the group's complete capabilities).",
    ...(preparationPending
      ? [
          "Tool preparation is still in progress; this directory is partial. tool_list/tool_search wait for the authorized catalog.",
        ]
      : []),
  ].join("\n");
  const lines = [header];
  // Reserve room for the omission notice so even multibyte catalogs stay bounded.
  let remaining = TOOL_GROUP_DIRECTORY_MAX_BYTES - Buffer.byteLength(header) - 160;
  let omitted = 0;
  for (const [prefix, example] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const line = JSON.stringify({
      namePrefix: prefix,
      example: example.name,
      description: Array.from(example.description).slice(0, 90).join(""),
    });
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes > remaining) {
      omitted++;
      continue;
    }
    lines.push(line);
    remaining -= bytes;
  }
  if (omitted > 0) {
    lines.push(
      `${omitted} additional groups omitted. Use tool_list without namePrefix to browse all authorized deferred tools.`,
    );
  }
  return lines.join("\n");
}
