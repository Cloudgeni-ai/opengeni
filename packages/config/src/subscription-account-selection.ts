/** Stable account affinity shared by subscription providers. Candidate order is durable creation order. */
export function subscriptionAccountShardIndex(sessionId: string, candidateCount: number): number {
  if (!Number.isSafeInteger(candidateCount) || candidateCount <= 0)
    throw new Error("Subscription shard candidate count must be positive");
  let hash = 0x811c9dc5;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % candidateCount;
}

/**
 * Manual pins are binding even when unavailable. Policy homes remain sticky only
 * while rotation is on; an exhausted home re-shards over the eligible survivors.
 * Selection never changes the pool's active pointer.
 */
export function selectSubscriptionAccount<T extends { id: string }>(input: {
  sessionId: string;
  eligible: readonly T[];
  rotationEnabled: boolean;
  activeCredentialId: string | null;
  pinnedCredentialId: string | null;
  pinSource: "manual" | "policy" | null;
}): T | null {
  const pinned = input.eligible.find((account) => account.id === input.pinnedCredentialId);
  if (input.pinnedCredentialId && input.pinSource !== "policy") return pinned ?? null;
  if (!input.rotationEnabled)
    return input.eligible.find((account) => account.id === input.activeCredentialId) ?? null;
  return (
    pinned ??
    (input.eligible.length
      ? input.eligible[subscriptionAccountShardIndex(input.sessionId, input.eligible.length)]!
      : null)
  );
}
