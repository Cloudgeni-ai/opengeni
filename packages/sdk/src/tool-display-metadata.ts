import type { ToolDisplayMetadata } from "@opengeni/contracts";

/** Browser/native-safe event projection; do not import server schema runtimes. */
export function parseToolDisplayMetadata(value: unknown): ToolDisplayMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["toolName", "title", "accountLabel"].includes(key)))
    return undefined;
  const text = (v: unknown, max: number): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= max;
  if (!text(item.toolName, 512) || /[\u0000-\u001f\u007f]/u.test(item.toolName)) return undefined;
  if (item.title !== undefined && !text(item.title, 512)) return undefined;
  if (item.accountLabel !== undefined && !text(item.accountLabel, 1024)) return undefined;
  return {
    toolName: item.toolName,
    ...(item.title !== undefined ? { title: item.title as string } : {}),
    ...(item.accountLabel !== undefined ? { accountLabel: item.accountLabel as string } : {}),
  };
}
