/**
 * Definitive refusals remain turn-local exclusions until the credential's
 * cooldown has been explicitly cleared. Health alone (including a fresh token
 * or an old, open usage cache) is not evidence that the refusal recovered.
 *
 * Cooldown writers serialize and increment exhaustedRevision; quota telemetry
 * can clear only an observed typed quota revision, never generic backpressure.
 * Keep the original failed-id ledger/count for replay and failover accounting.
 */
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
    const recorded = revisions?.[id];
    // Legacy ID-only receipts cannot distinguish a status refusal from a quota
    // refusal, or establish whether a clear predates this turn's failure. Keep
    // them excluded. Null denotes a status refusal: quota repair cannot undo it.
    const baseline = recorded;
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
