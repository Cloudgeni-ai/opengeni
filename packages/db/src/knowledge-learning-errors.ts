/** Startup-only domain failure: a new message must accept the current scope. */
export class KnowledgeLearningScopeChangedError extends Error {
  readonly code = "knowledge_learning_scope_changed";

  constructor(cause: unknown) {
    super(
      "This turn's Knowledge scope no longer matches this chat. Send a new message to continue with the current settings.",
      { cause },
    );
    this.name = "KnowledgeLearningScopeChangedError";
  }
}

/** Match the exact guard, including on a server not yet migrated; never expose SQL. */
export function isKnowledgeLearningScopeGuardError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.code === "42501" && record.message === "Learning scope changed after acceptance")
      return true;
    current = record.cause;
  }
  return false;
}
