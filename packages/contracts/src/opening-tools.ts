/**
 * Tools a new session's opening context is for, such as the tool that reaches
 * the open document a chat starts bound to. Frozen once in the initial turn's
 * metadata at creation; that turn's first model step loads them the way a
 * tool_search by name does. Dependency-free so any package can read it.
 */

/** Turn metadata key for the opening tools of a session's initial turn. */
export const OPENING_TOOLS_METADATA_KEY = "openingTools" as const;

/** Most opening tools one session may name. */
export const OPENING_TOOLS_MAX = 16;

/** The opening tools frozen in one turn's metadata; empty when it names none. */
export function openingToolsFromTurnMetadata(metadata: unknown): string[] {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return [];
  const value = (metadata as Record<string, unknown>)[OPENING_TOOLS_METADATA_KEY];
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (name): name is string => typeof name === "string" && name.length > 0 && name.length <= 200,
      ),
    ),
  ].slice(0, OPENING_TOOLS_MAX);
}
