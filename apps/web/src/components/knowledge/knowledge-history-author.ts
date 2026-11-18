import type { KnowledgeEntryScope } from "@opengeni/contracts";

/**
 * Who saved a version of a Knowledge entry, as its history names them:
 * "Opengeni" for an agent's change, "You" for your own (a personal entry, or
 * a version the server lists in `savedByYou`), and "A teammate" otherwise.
 */
export function authorOf(
  revision: { id: string; createdBySessionId: string | null },
  scope: KnowledgeEntryScope,
  savedByYou: ReadonlySet<string> = new Set(),
): string {
  if (revision.createdBySessionId) return "Opengeni";
  return scope === "personal" || savedByYou.has(revision.id) ? "You" : "A teammate";
}

/**
 * The versions a history page says the person asking saved. Servers before
 * migration 1498 leave it out; anything malformed counts as none.
 */
export function savedByYouOf(page: object): string[] {
  const value: unknown = (page as { savedByYou?: unknown }).savedByYou;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}
