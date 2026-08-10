import {
  FIKEN_CREDENTIAL_ROLE,
  FIKEN_PROVIDER_DOMAIN,
  FikenConnectionMetadata,
  type ConnectionMetadata,
  type FikenConnectionMetadata as FikenMetadata,
} from "@opengeni/contracts";

export function fikenConnectionMetadata(metadata: Record<string, unknown>): FikenMetadata | null {
  const parsed = FikenConnectionMetadata.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

/**
 * A workspace-shared Fiken connection created through the verified install
 * route. Phase 1 deliberately supports only workspace ownership; personal
 * ownership arrives with the OAuth connector and its delegation snapshots.
 */
export function isFikenConnection(connection: ConnectionMetadata): boolean {
  return (
    connection.subjectId === null &&
    connection.providerDomain === FIKEN_PROVIDER_DOMAIN &&
    connection.kind === "api_key" &&
    fikenConnectionMetadata(connection.metadata)?.credentialRole === FIKEN_CREDENTIAL_ROLE
  );
}

/**
 * The row a capability tile or tool default should bind to when several Fiken
 * connections exist: usable status first, then newest update, then immutable
 * UUID descending as the stable tie-breaker.
 */
export function preferredFikenConnection<
  T extends Pick<ConnectionMetadata, "status" | "updatedAt" | "id">,
>(connections: readonly T[]): T | null {
  const statusRank = (status: ConnectionMetadata["status"]): number =>
    status === "active" ? 0 : status === "needs_reauth" ? 1 : 2;
  return (
    [...connections].sort(
      (left, right) =>
        statusRank(left.status) - statusRank(right.status) ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.id.localeCompare(left.id),
    )[0] ?? null
  );
}
