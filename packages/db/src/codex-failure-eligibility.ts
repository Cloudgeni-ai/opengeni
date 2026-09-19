/** Refusal-specific, ordered recovery evidence; never erase the failure ledger. */
export function unresolvedCodexCredentialFailures(
  metadata: Record<string, unknown> | null | undefined,
  accounts: readonly {
    id: string;
    status: string;
    exhaustedUntil: Date | null;
    exhaustedKind: string | null;
    exhaustedRevision?: number;
    credentialVersion?: number;
  }[],
  now = new Date(),
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
  const rawEvidence = metadata?.codexCredentialFailureEvidenceV1;
  const evidence =
    rawEvidence && typeof rawEvidence === "object" && !Array.isArray(rawEvidence)
      ? (rawEvidence as Record<string, unknown>)
      : null;
  return [...new Set(failedIds)].filter((id) => {
    const account = accounts.find((candidate) => candidate.id === id);
    const revision = account?.exhaustedRevision;
    const baseline = revisions?.[id];
    const rawReceipt = evidence?.[id];
    const receipt =
      rawReceipt && typeof rawReceipt === "object" && !Array.isArray(rawReceipt)
        ? (rawReceipt as Record<string, unknown>)
        : null;
    if (
      rawReceipt !== undefined &&
      (!receipt || !["quota", "rate_limit", "status"].includes(String(receipt.kind)))
    )
      return true;
    // The earlier atomic quarantine writer used explicit null only for status
    // refusals (it wrote needs_relogin/error in the same transaction). Seeing
    // active again therefore proves a later repair. Missing ID-only evidence
    // is different and remains excluded. New receipts additionally fence the
    // repaired credential version below.
    if (!receipt && baseline === null && account?.status === "active") return false;
    if (account?.status === "active" && receipt?.kind === "status") {
      return !(
        typeof receipt.credentialVersion === "number" &&
        Number.isSafeInteger(receipt.credentialVersion) &&
        receipt.credentialVersion >= 1 &&
        typeof account.credentialVersion === "number" &&
        Number.isSafeInteger(account.credentialVersion) &&
        account.credentialVersion > receipt.credentialVersion
      );
    }
    if (
      account?.status === "active" &&
      ((receipt?.kind === "rate_limit" &&
        typeof receipt.cooldownRevision === "number" &&
        Number.isSafeInteger(receipt.cooldownRevision) &&
        receipt.cooldownRevision >= 1 &&
        typeof revision === "number" &&
        revision >= receipt.cooldownRevision) ||
        (!receipt &&
          typeof baseline === "number" &&
          Number.isSafeInteger(baseline) &&
          baseline >= 1 &&
          revision === baseline)) &&
      typeof revision === "number" &&
      Number.isSafeInteger(revision) &&
      account.exhaustedKind === "rate_limit" &&
      account.exhaustedUntil !== null &&
      account.exhaustedUntil.getTime() <= now.getTime()
    ) {
      return false;
    }
    // Quota recovery needs an ordered explicit clear, including older numeric receipts.
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
