import { parseToolArgs } from "./parsers";
import { mcpToolLeaf } from "./tool-display-name";
import type { ToolCallItem } from "./types";

/** The tool a `tool_invoke` call ran, or null for any other call. */
export function invokedTool(
  name: string,
  rawArguments: unknown,
): { name: string; arguments: unknown } | null {
  if (mcpToolLeaf(name) !== "tool_invoke") return null;
  const args = parseToolArgs(rawArguments);
  if (typeof args.name !== "string" || !args.name.trim()) return null;
  return { name: args.name, arguments: args.arguments ?? {} };
}

/**
 * A `tool_invoke` call shown as the tool it ran, so the row reads "Run on …"
 * instead of "Tool invoke". Any other call comes back unchanged.
 */
export function invokedToolCall(item: ToolCallItem): ToolCallItem {
  const invoked = invokedTool(item.name, item.arguments);
  if (!invoked) return item;
  const { display: _display, ...rest } = item;
  return { ...rest, ...invoked };
}
