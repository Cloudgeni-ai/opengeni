import { parseToolArgs } from "./parsers";
import { mcpToolLeaf } from "./tool-display-name";
import type { ToolCallItem } from "./types";

/**
 * A `tool_invoke` call shown as the tool it ran, so the row reads "Run on …"
 * instead of "Tool invoke". Any other call comes back unchanged.
 */
export function invokedToolCall(item: ToolCallItem): ToolCallItem {
  if (mcpToolLeaf(item.name) !== "tool_invoke") return item;
  const args = parseToolArgs(item.arguments);
  if (typeof args.name !== "string" || !args.name.trim()) return item;
  const { display: _display, ...rest } = item;
  return { ...rest, name: args.name, arguments: args.arguments ?? {} };
}
