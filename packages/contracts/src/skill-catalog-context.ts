/** Durable, model-visible catalog context. Text markers survive SDK/provider replay. */
export const SKILL_CATALOG_CONTEXT_PREFIX = "<opengeni_skill_catalog>\n";
export const SKILL_CATALOG_CONTEXT_SUFFIX = "\n</opengeni_skill_catalog>";
const GUIDANCE =
  "This is the current Skill index and replaces earlier Skill indexes. " +
  "Entries describe discoverability, not permission or full instructions. " +
  "Use skill_read for instructions and skill_search for current discovery; tool authorization remains authoritative.\n\n";

export function skillCatalogContextItem(catalog: string): Record<string, unknown> {
  return {
    type: "message",
    role: "developer",
    content: SKILL_CATALOG_CONTEXT_PREFIX + GUIDANCE + catalog + SKILL_CATALOG_CONTEXT_SUFFIX,
  };
}

/** Accept the Chat Completions projection and SDK text-part normalization too. */
export function readSkillCatalogContext(item: Record<string, unknown>): string | null {
  if (item.type === "unknown" && item.providerData && typeof item.providerData === "object") {
    const data = item.providerData as Record<string, unknown>;
    if (data.type === "message") return readSkillCatalogContext(data);
  }
  if (item.type !== "message" || (item.role !== "developer" && item.role !== "system")) return null;
  const content =
    typeof item.content === "string"
      ? item.content
      : Array.isArray(item.content) &&
          item.content.every(
            (part) =>
              part &&
              (part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
              typeof part.text === "string",
          )
        ? item.content.map((part) => part.text).join("")
        : null;
  const prefix = SKILL_CATALOG_CONTEXT_PREFIX + GUIDANCE;
  return content?.startsWith(prefix) && content.endsWith(SKILL_CATALOG_CONTEXT_SUFFIX)
    ? content.slice(prefix.length, -SKILL_CATALOG_CONTEXT_SUFFIX.length)
    : null;
}

export function latestSkillCatalogContext(
  items: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const catalog = readSkillCatalogContext(items[index]!);
    if (catalog !== null) return skillCatalogContextItem(catalog);
  }
  return undefined;
}
