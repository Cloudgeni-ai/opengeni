/**
 * Durable, model-visible index of the repository Skills found in the live
 * workspace.
 *
 * The index changes whenever a repository Skill is added or removed, or the
 * workspace cannot be read. In the system prompt each change rewrote text that
 * earlier requests had sent, which invalidated the cached history and the
 * provider's binding of earlier reasoning to that prompt. The system prompt
 * therefore carries only a stable notice, and the index is a developer
 * history item inserted before the turn that first sees a new value. Earlier
 * items stay byte-identical, and the newest item replaces older ones.
 */
export const REPOSITORY_SKILLS_CONTEXT_PREFIX = "<opengeni_repository_skills>\n";
export const REPOSITORY_SKILLS_CONTEXT_SUFFIX = "\n</opengeni_repository_skills>";
const GUIDANCE =
  "This is the Repository skills index from the last time the live workspace was indexed, and it replaces earlier ones. Files may have changed since.\n\n";

export function repositorySkillsContextItem(index: string): Record<string, unknown> {
  return {
    type: "message",
    role: "developer",
    content: REPOSITORY_SKILLS_CONTEXT_PREFIX + GUIDANCE + index + REPOSITORY_SKILLS_CONTEXT_SUFFIX,
  };
}

/** Accept the Chat Completions projection and SDK text-part normalization too. */
export function readRepositorySkillsContext(item: Record<string, unknown>): string | null {
  if (item.type === "unknown" && item.providerData && typeof item.providerData === "object") {
    const data = item.providerData as Record<string, unknown>;
    if (data.type === "message") return readRepositorySkillsContext(data);
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
  // Items are recognized by their tags, so stored items stay readable if the
  // guidance wording changes; only the current guidance is removed.
  if (
    !content?.startsWith(REPOSITORY_SKILLS_CONTEXT_PREFIX) ||
    !content.endsWith(REPOSITORY_SKILLS_CONTEXT_SUFFIX) ||
    content.length <
      REPOSITORY_SKILLS_CONTEXT_PREFIX.length + REPOSITORY_SKILLS_CONTEXT_SUFFIX.length
  )
    return null;
  const body = content.slice(
    REPOSITORY_SKILLS_CONTEXT_PREFIX.length,
    -REPOSITORY_SKILLS_CONTEXT_SUFFIX.length,
  );
  return body.startsWith(GUIDANCE) ? body.slice(GUIDANCE.length) : body;
}

/** The index text of the newest item, or null when there is none. */
export function latestRepositorySkillsIndex(items: readonly unknown[]): string | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item || typeof item !== "object") continue;
    const text = readRepositorySkillsContext(item as Record<string, unknown>);
    if (text !== null) return text;
  }
  return null;
}

export function latestRepositorySkillsContext(
  items: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  const text = latestRepositorySkillsIndex(items);
  return text === null ? undefined : repositorySkillsContextItem(text);
}
