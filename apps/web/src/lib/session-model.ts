/** Codex subscription product ids are prefixed `codex/`. */
export function isCodexProductModel(modelId: string): boolean {
  return modelId.startsWith("codex/");
}

/**
 * Next-turn model for an open session.
 *
 * Prefer the in-memory / resolved `requested` id, but on remote compaction v2
 * never keep a non-Codex id when the durable session model is Codex — that
 * mismatch selected the deployment OpenAI default and labeled it "5.6-SOL".
 */
export function resolveSessionComposerModel(input: {
  requested: string;
  durableSessionModel: string;
  codexCompactionMode: "remote_v2" | "portable";
}): string {
  if (
    input.codexCompactionMode === "remote_v2" &&
    !isCodexProductModel(input.requested) &&
    isCodexProductModel(input.durableSessionModel)
  ) {
    return input.durableSessionModel;
  }
  return input.requested;
}
