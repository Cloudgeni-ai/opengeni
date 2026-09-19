/** A newer revision-fenced cooldown clear is required to undo a definitive refusal. */
export function unresolvedCodexCredentialFailures(
  metadata: Record<string, unknown> | null | undefined,
  accounts: readonly {
    id: string;
    status: string;
    exhaustedUntil: Date | null;
    exhaustedKind: string | null;
    exhaustedRevision?: number;
  }[],
): string[] {
  const failedIds = Array.isArray(metadata?.codexCredentialFailedIds)
    ? metadata.codexCredentialFailedIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      )
    : [];
  const rawRevisions = metadata?.codexCredentialFailureCooldownRevisions;
  const revisions =
    rawRevisions && typeof rawRevisions === "object" && !Array.isArray(rawRevisions)
      ? (rawRevisions as Record<string, unknown>)
      : null;
  return [...new Set(failedIds)].filter((id) => {
    const account = accounts.find((candidate) => candidate.id === id);
    const revision = account?.exhaustedRevision;
    const baseline = revisions?.[id];
    // Legacy ID-only and status-only receipts cannot prove ordered quota recovery.
    return !(
      account?.status === "active" &&
      account.exhaustedUntil === null &&
      account.exhaustedKind === null &&
      typeof baseline === "number" &&
      Number.isSafeInteger(baseline) &&
      baseline >= 1 &&
      typeof revision === "number" &&
      Number.isSafeInteger(revision) &&
      revision > baseline
    );
  });
}
