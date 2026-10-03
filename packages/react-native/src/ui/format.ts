import type { ActivityItem, TimelineGroup, ToolCallItem } from "@opengeni/react/session";
import { toolDisplayName } from "@opengeni/react/session";

export function toolTitle(item: ToolCallItem): string {
  return toolDisplayName(item.name, item.display);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** One-line human summary of a tool call's input. */
export function toolDetail(item: ToolCallItem): string | null {
  const args = item.arguments;
  if (typeof args === "string") return args.split("\n")[0] ?? null;
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  const known = firstString(record, ["cmd", "command", "query", "q", "path", "url", "title", "id", "name"]);
  if (known) return known;
  const pairs = Object.entries(record)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .slice(0, 3)
    .map(([key, value]) => `${key.replace(/[_-]+/g, " ")}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  if (pairs.length === 0) return null;
  const text = pairs.join(" · ");
  return text.length > 110 ? `${text.slice(0, 109)}…` : text;
}

/** Short preview of a settled tool output. */
export function toolOutputPreview(item: ToolCallItem, lines = 2): string | null {
  const output = item.output;
  const text =
    typeof output === "string"
      ? output
      : output && typeof output === "object" && typeof (output as { text?: unknown }).text === "string"
        ? String((output as { text: string }).text)
        : output == null
          ? null
          : JSON.stringify(output);
  if (!text) return null;
  return text.split("\n").slice(0, lines).join("\n");
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function itemTime(item: { occurredAt?: string }): number {
  return item.occurredAt ? Date.parse(item.occurredAt) : Number.NaN;
}

/** Flatten nested work details of a group into its activity items, in order. */
export function activityItemsOf(group: TimelineGroup): ActivityItem[] {
  if (group.kind === "item") return [];
  if (group.kind === "turn") return group.groups.flatMap(activityItemsOf);
  const nested = group.work?.details.flatMap(activityItemsOf) ?? [];
  return nested.length > 0 ? nested : group.items;
}

export function toolCallsOf(items: readonly ActivityItem[]): ToolCallItem[] {
  return items.filter((item): item is ToolCallItem => item.kind === "tool-call");
}