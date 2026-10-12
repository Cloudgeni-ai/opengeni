import type { Settings } from "@opengeni/config";
import type { ConnectionMetadata, VaultErrorCode } from "@opengeni/contracts";
import {
  getConnectionMetadata,
  loadConnectionCredentialForBroker,
  type Database,
} from "@opengeni/db";
import {
  createVaultProviderRegistry,
  VaultProviderError,
  type VaultProvider,
  type VaultProviderErrorCode,
  type VaultProviderRegistry,
} from "@opengeni/vaults";

/**
 * Provider error codes as vault API error codes (§10B.1.1). `provider_not_found`
 * is the vault (or, for reads, the field); `provider_permission_denied` is
 * `vault_read_only` for writes and `vault_permission_denied` otherwise.
 */
export function vaultErrorCodeForProvider(
  code: VaultProviderErrorCode,
  operation: "read" | "write" | "vault",
): VaultErrorCode {
  if (code === "provider_not_found") {
    return operation === "read" ? "vault_field_not_found" : "vault_not_found";
  }
  if (code === "provider_permission_denied") {
    return operation === "write" ? "vault_read_only" : "vault_permission_denied";
  }
  return code;
}

/**
 * 1Password service-account connections (dossier §10.9). The token lives in
 * the existing encrypted connection-credential store as `{ token }` (no
 * `headers`, so the egress broker can never inject it); metadata carries only
 * `{ credentialRole, planTier, ownership, accountName, label, verifiedAt }`.
 */
export const ONEPASSWORD_PROVIDER_DOMAIN = "1password.com";
export const ONEPASSWORD_CREDENTIAL_ROLE = "onepassword_service_account";

export type OnePasswordPlanTier = "family" | "teams" | "business";
export type OnePasswordConnectionOwnership = "user" | "workspace" | "organization";
export type OnePasswordConnectionMetadata = {
  credentialRole: typeof ONEPASSWORD_CREDENTIAL_ROLE;
  planTier: OnePasswordPlanTier;
  ownership: OnePasswordConnectionOwnership;
  /** Sign-in host from the token, for example "my.1password.com". */
  accountName: string | null;
  label: string | null;
  verifiedAt: string;
};

const PLAN_TIERS: readonly OnePasswordPlanTier[] = ["family", "teams", "business"];
const OWNERSHIPS: readonly OnePasswordConnectionOwnership[] = ["user", "workspace", "organization"];

export function onePasswordConnectionMetadata(
  metadata: Record<string, unknown> | null | undefined,
): OnePasswordConnectionMetadata | null {
  if (!metadata || metadata.credentialRole !== ONEPASSWORD_CREDENTIAL_ROLE) return null;
  const planTier = PLAN_TIERS.includes(metadata.planTier as OnePasswordPlanTier)
    ? (metadata.planTier as OnePasswordPlanTier)
    : // §10.9: assume TEAMS when the plan is unknown.
      "teams";
  const ownership = OWNERSHIPS.includes(metadata.ownership as OnePasswordConnectionOwnership)
    ? (metadata.ownership as OnePasswordConnectionOwnership)
    : "workspace";
  return {
    credentialRole: ONEPASSWORD_CREDENTIAL_ROLE,
    planTier,
    ownership,
    accountName: typeof metadata.accountName === "string" ? metadata.accountName : null,
    label: typeof metadata.label === "string" ? metadata.label : null,
    verifiedAt: typeof metadata.verifiedAt === "string" ? metadata.verifiedAt : "",
  };
}

export function isOnePasswordConnection(connection: ConnectionMetadata): boolean {
  return (
    connection.providerDomain.toLowerCase() === ONEPASSWORD_PROVIDER_DOMAIN &&
    connection.kind === "api_key" &&
    onePasswordConnectionMetadata(connection.metadata) !== null
  );
}

/**
 * Builds a provider for one stored token. Supplied by apps/api and apps/worker
 * as `(input) => import("@opengeni/vaults-onepassword").then(...)`, so core
 * never loads the 1Password SDK (OP-5).
 */
export type OnePasswordVaultProviderFactory = (input: {
  token: string;
  planTier: OnePasswordPlanTier;
  allowFakeTokens: boolean;
}) => Promise<VaultProvider>;

export function onePasswordCredentialBundle(token: string): Record<string, unknown> {
  return { token };
}

/**
 * Decrypts the token of one 1Password connection the caller can see
 * (workspace-shared, or personal to `subjectId`). The token goes only to the
 * provider factory; it is never logged or returned to a client.
 */
export async function loadOnePasswordConnectionToken(
  db: Database,
  settings: Settings,
  input: { workspaceId: string; connectionId: string; subjectId: string | null },
): Promise<{ token: string; metadata: OnePasswordConnectionMetadata }> {
  const unavailable = () =>
    new VaultProviderError(
      "provider_auth_invalid",
      "The 1Password connection for this vault was removed or is not available to you; reconnect 1Password",
    );
  const connection = await getConnectionMetadata(
    db,
    input.workspaceId,
    input.connectionId,
    input.subjectId,
  );
  if (!connection || !isOnePasswordConnection(connection)) throw unavailable();
  if (connection.status !== "active") {
    throw new VaultProviderError(
      "provider_auth_expired",
      "The 1Password connection needs a new service account token",
    );
  }
  const personal = connection.subjectId !== null;
  const credential = await loadConnectionCredentialForBroker(db, settings, {
    workspaceId: input.workspaceId,
    connectionId: connection.id,
    providerDomain: ONEPASSWORD_PROVIDER_DOMAIN,
    kind: "api_key",
    ...(personal ? { allowSubjectOwned: true, subjectId: connection.subjectId } : {}),
  });
  const token = (credential?.credential as { token?: unknown } | undefined)?.token;
  if (!credential || typeof token !== "string" || !token) throw unavailable();
  return { token, metadata: onePasswordConnectionMetadata(connection.metadata)! };
}

/**
 * The provider registry for one workspace request or attempt:
 * - `onepassword` vaults load their connection token and the SDK lazily;
 * - `host` vaults use the embedder's `connectionCredentials.vaultProvider`.
 */
export function createWorkspaceVaultProviderRegistry(input: {
  db: Database;
  settings: Settings;
  workspaceId: string;
  /** The acting subject; personal 1Password connections resolve only for their owner. */
  subjectId: string | null;
  hostVaultProvider?: VaultProvider | null;
  onePasswordVaultProvider?: OnePasswordVaultProviderFactory | null;
}): VaultProviderRegistry {
  const factory = input.onePasswordVaultProvider;
  const host = input.hostVaultProvider;
  return createVaultProviderRegistry({
    ...(factory
      ? {
          async onepassword(connectionId: string | null) {
            if (!connectionId) {
              throw new VaultProviderError(
                "provider_unavailable",
                "This 1Password vault has no connection",
              );
            }
            const { token, metadata } = await loadOnePasswordConnectionToken(
              input.db,
              input.settings,
              { workspaceId: input.workspaceId, connectionId, subjectId: input.subjectId },
            );
            return factory({
              token,
              planTier: metadata.planTier,
              allowFakeTokens: input.settings.onePasswordFakeTokens,
            });
          },
        }
      : {}),
    ...(host ? { host: async () => host } : {}),
  });
}
