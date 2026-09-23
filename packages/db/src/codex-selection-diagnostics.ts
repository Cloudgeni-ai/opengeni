/** Observations about this session, never allocator inputs or failover policy. */
export function codexSelectionDiagnostics(input: {
  previousCredentialId: string | null;
  credentialId: string;
  reusedLease: boolean;
  pinnedCredentialId: string | null;
  pinSource?: "manual" | "policy" | null;
}) {
  const transition =
    input.previousCredentialId === input.credentialId
      ? ("unchanged" as const)
      : input.previousCredentialId === null
        ? ("assigned" as const)
        : ("switched" as const);
  const source =
    input.pinnedCredentialId === input.credentialId && input.pinSource !== "policy"
      ? ("manual_pin" as const)
      : ("allocator" as const);
  const reason = input.reusedLease
    ? ("lease_reused" as const)
    : transition === "unchanged"
      ? ("affinity_reused" as const)
      : transition;
  return { transition, source, reason };
}
