import {
  FIKEN_CREDENTIAL_LABEL,
  FIKEN_CREDENTIAL_ROLE,
  FIKEN_PROVIDER_DOMAIN,
  FikenConnectionMetadata,
  type ConnectionMetadata,
  type FikenCompanySummary,
  type FikenConnectionMetadata as FikenMetadata,
} from "@opengeni/contracts";

export function fikenConnectionMetadata(metadata: Record<string, unknown>): FikenMetadata | null {
  const parsed = FikenConnectionMetadata.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

/**
 * A workspace-shared Fiken connection created through one of the verified
 * install paths: the pasted personal API token (`api_key`) or the Fiken OAuth
 * app flow (`oauth2`). Both are deliberately workspace-owned; personal
 * ("Connect only for me") ownership needs the delegation-snapshot lane and is
 * not yet wired for the first-party fiken tools.
 */
export function isFikenConnection(connection: ConnectionMetadata): boolean {
  return (
    connection.subjectId === null &&
    connection.providerDomain === FIKEN_PROVIDER_DOMAIN &&
    (connection.kind === "api_key" || connection.kind === "oauth2") &&
    fikenConnectionMetadata(connection.metadata)?.credentialRole === FIKEN_CREDENTIAL_ROLE
  );
}

/**
 * The Fiken credential role is reserved for the verified install routes.
 * Generic connection create/update must reject it so a caller cannot forge a
 * "verified" Fiken row (with attacker-chosen companies metadata) that the
 * first-party fiken tools would then bind to. Mirrors the Slack bot guard.
 */
export function hasReservedFikenMetadata(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return (
    metadata?.credentialRole === FIKEN_CREDENTIAL_ROLE ||
    metadata?.credentialLabel === FIKEN_CREDENTIAL_LABEL
  );
}

/**
 * One default-company rule for both verified lanes: an explicit request wins
 * when the credential can access it, then a still-accessible previous default
 * survives reconnect, then a single-company credential auto-selects. Returns
 * null (caller decides whether that is an error) when a requested slug is not
 * among the verified companies.
 */
export function resolveFikenDefaultCompanySlug(input: {
  requested: string | null;
  previous: string | null;
  companies: readonly FikenCompanySummary[];
}): string | null {
  const accessible = (slug: string | null): slug is string =>
    slug !== null && input.companies.some((company) => company.slug === slug);
  if (input.requested !== null) {
    return accessible(input.requested) ? input.requested : null;
  }
  if (accessible(input.previous)) {
    return input.previous;
  }
  return input.companies.length === 1 ? input.companies[0]!.slug : null;
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
