import type { OpenGeniClient } from "./client";
import type { VaultPolicy } from "./types";
import type {
  CreateManagedProviderVaultRequest,
  CreateVaultItemRequest,
  CreateVaultRequest,
  DisconnectOnePasswordResponse,
  InstallOnePasswordRequest,
  InstallOnePasswordResponse,
  LinkProviderVaultRequest,
  ListVaultItemsQuery,
  MoveVaultItemRequest,
  OnePasswordConnectionSummary,
  ProviderVaultMeta,
  ReplaceOnePasswordTokenRequest,
  RevealVaultFieldResponse,
  SessionSecretsView,
  UpdateVaultItemRequest,
  UpdateVaultRequest,
  VaultErrorCode,
  VaultFieldVersionMeta,
  VaultItem,
  VaultItemSummary,
  VaultSummary,
  InstallVaultProviderRequest,
  InstallVaultProviderResponse,
  ReplaceVaultProviderCredentialsRequest,
  VaultProviderConnectionSummary,
  DisconnectVaultProviderResponse,
} from "./vault-types";

/**
 * Vault REST routes over the client's JSON transport. Responses carry metadata
 * only; plaintext comes back only from `revealField`, and callers keep it in
 * memory for as long as they need it, never in a cache.
 */
export type VaultClientLike = Pick<OpenGeniClient, "requestJson">;

/**
 * The client's JSON transport. A client without one still renders (a disabled
 * hook never calls it); each request then fails with a clear error.
 */
export function asVaultClient(client: unknown): VaultClientLike {
  if (
    client &&
    typeof client === "object" &&
    "requestJson" in client &&
    typeof (client as { requestJson: unknown }).requestJson === "function"
  ) {
    return client as VaultClientLike;
  }
  return {
    requestJson: (() =>
      Promise.reject(
        new Error("Vaults need a client with requestJson."),
      )) as VaultClientLike["requestJson"],
  };
}

const enc = encodeURIComponent;

function itemsQuery(query: ListVaultItemsQuery): Record<string, string> {
  const out: Record<string, string> = {};
  if (query.q) out.q = query.q;
  if (query.type) out.type = query.type;
  if (query.includeArchived) out.includeArchived = "true";
  if (query.cursor) out.cursor = query.cursor;
  if (query.limit) out.limit = String(query.limit);
  return out;
}

export function vaultsApi(client: VaultClientLike, workspaceId: string) {
  const base = `/v1/workspaces/${enc(workspaceId)}`;
  const vault = (vaultId: string) => `${base}/vaults/${enc(vaultId)}`;
  const item = (vaultId: string, itemId: string) => `${vault(vaultId)}/items/${enc(itemId)}`;
  const field = (vaultId: string, itemId: string, fieldId: string) =>
    `${item(vaultId, itemId)}/fields/${enc(fieldId)}`;
  const json = <T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
    signal?: AbortSignal,
  ) => client.requestJson<T>(method, path, body, query ?? {}, signal ? { signal } : {});
  return {
    listVaults: async (signal?: AbortSignal) =>
      (await json<{ vaults: VaultSummary[] }>("GET", `${base}/vaults`, undefined, {}, signal))
        .vaults,
    getVault: (vaultId: string, signal?: AbortSignal) =>
      json<VaultSummary>("GET", vault(vaultId), undefined, {}, signal),
    createVault: (request: CreateVaultRequest) =>
      json<VaultSummary>("POST", `${base}/vaults`, request),
    updateVault: (vaultId: string, request: UpdateVaultRequest) =>
      json<VaultSummary>("PATCH", vault(vaultId), request),
    deleteVault: (vaultId: string, confirmName: string) =>
      client.requestJson<void>(
        "DELETE",
        vault(vaultId),
        { confirmName },
        {},
        { responseType: "void" },
      ),
    syncVault: (vaultId: string) => json<VaultSummary>("POST", `${vault(vaultId)}/sync`, {}),
    listItems: (vaultId: string, query: ListVaultItemsQuery = {}, signal?: AbortSignal) =>
      json<{ items: VaultItemSummary[]; nextCursor: string | null }>(
        "GET",
        `${vault(vaultId)}/items`,
        undefined,
        itemsQuery(query),
        signal,
      ),
    getItem: (vaultId: string, itemId: string, signal?: AbortSignal) =>
      json<VaultItem>("GET", item(vaultId, itemId), undefined, {}, signal),
    createItem: (vaultId: string, request: CreateVaultItemRequest) =>
      json<VaultItem>("POST", `${vault(vaultId)}/items`, request),
    updateItem: (vaultId: string, itemId: string, request: UpdateVaultItemRequest) =>
      json<VaultItem>("PATCH", item(vaultId, itemId), request),
    /** Archives; `permanent` deletes an archived item. */
    deleteItem: (vaultId: string, itemId: string, permanent = false) =>
      client.requestJson<void>(
        "DELETE",
        item(vaultId, itemId),
        undefined,
        permanent ? { permanent: "true" } : {},
        { responseType: "void" },
      ),
    restoreItem: (vaultId: string, itemId: string) =>
      json<VaultItem>("POST", `${item(vaultId, itemId)}/restore`, {}),
    moveItem: (vaultId: string, itemId: string, request: MoveVaultItemRequest) =>
      json<VaultItem>("POST", `${item(vaultId, itemId)}/move`, request),
    /** Plaintext. Audited server-side. Never cache the result. */
    revealField: (vaultId: string, itemId: string, fieldId: string, version?: number) =>
      json<RevealVaultFieldResponse>(
        "POST",
        `${field(vaultId, itemId, fieldId)}/reveal`,
        version === undefined ? {} : { version },
      ),
    listFieldVersions: async (
      vaultId: string,
      itemId: string,
      fieldId: string,
      signal?: AbortSignal,
    ) =>
      (
        await json<{ versions: VaultFieldVersionMeta[] }>(
          "GET",
          `${field(vaultId, itemId, fieldId)}/versions`,
          undefined,
          {},
          signal,
        )
      ).versions,
    restoreFieldVersion: (vaultId: string, itemId: string, fieldId: string, version: number) =>
      json<VaultItem>("POST", `${field(vaultId, itemId, fieldId)}/restore`, { version }),
    getSessionSecrets: (sessionId: string, signal?: AbortSignal) =>
      json<SessionSecretsView>(
        "GET",
        `${base}/sessions/${enc(sessionId)}/secrets`,
        undefined,
        {},
        signal,
      ),
    setSessionVaultPolicy: (sessionId: string, policy: VaultPolicy) =>
      json<SessionSecretsView>("PUT", `${base}/sessions/${enc(sessionId)}/vault-policy`, {
        policy,
      }),
    installOnePassword: (request: InstallOnePasswordRequest) =>
      json<InstallOnePasswordResponse>("POST", `${base}/connections/1password/install`, request),
    /** The 1Password connections the caller can see. */
    listOnePasswordConnections: async (signal?: AbortSignal) =>
      (
        await json<{ connections: OnePasswordConnectionSummary[] }>(
          "GET",
          `${base}/connections/1password/service-accounts`,
          undefined,
          {},
          signal,
        )
      ).connections,
    /** Checks a new service account token and stores it on the same connection. */
    replaceOnePasswordToken: (connectionId: string, request: ReplaceOnePasswordTokenRequest) =>
      json<InstallOnePasswordResponse>(
        "PUT",
        `${base}/connections/${enc(connectionId)}/1password/token`,
        request,
      ),
    /** Unlinks the connection's vaults (nothing is deleted in 1Password) and removes its token. */
    disconnectOnePassword: (connectionId: string) =>
      json<DisconnectOnePasswordResponse>(
        "DELETE",
        `${base}/connections/${enc(connectionId)}/1password`,
      ),
    listProviderVaults: async (connectionId: string, signal?: AbortSignal) =>
      (
        await json<{ vaults: ProviderVaultMeta[] }>(
          "GET",
          `${base}/connections/${enc(connectionId)}/provider-vaults`,
          undefined,
          {},
          signal,
        )
      ).vaults,
    installVaultProvider: (request: InstallVaultProviderRequest) =>
      json<InstallVaultProviderResponse>("POST", `${base}/vault-providers/connections`, request),
    listVaultProviderConnections: async (signal?: AbortSignal) =>
      (
        await json<{ connections: VaultProviderConnectionSummary[] }>(
          "GET",
          `${base}/vault-providers/connections`,
          undefined,
          {},
          signal,
        )
      ).connections,
    replaceVaultProviderCredentials: (
      connectionId: string,
      request: ReplaceVaultProviderCredentialsRequest,
    ) =>
      json<InstallVaultProviderResponse>(
        "PUT",
        `${base}/vault-providers/connections/${enc(connectionId)}/credentials`,
        request,
      ),
    disconnectVaultProvider: (connectionId: string) =>
      json<DisconnectVaultProviderResponse>(
        "DELETE",
        `${base}/vault-providers/connections/${enc(connectionId)}`,
      ),
    /** Continue verification using the saved credentials, without replaying setup tokens. */
    verifyVaultProviderConnection: (connectionId: string) =>
      json<InstallVaultProviderResponse>(
        "POST",
        `${base}/vault-providers/connections/${enc(connectionId)}/verify`,
        {},
      ),
    linkProviderVault: (request: LinkProviderVaultRequest) =>
      json<VaultSummary>("POST", `${base}/vaults/link`, request),
    createManagedProviderVault: (
      connectionId: string,
      request: CreateManagedProviderVaultRequest,
    ) =>
      json<VaultSummary>(
        "POST",
        `${base}/connections/${enc(connectionId)}/managed-vaults`,
        request,
      ),
  };
}

export type VaultsApi = ReturnType<typeof vaultsApi>;

const VAULT_ERROR_CODES: ReadonlySet<string> = new Set<VaultErrorCode>([
  "vault_not_found",
  "vault_item_not_found",
  "vault_field_not_found",
  "vault_name_conflict",
  "vault_item_name_conflict",
  "vault_limit_reached",
  "vault_read_only",
  "vault_generation_conflict",
  "vault_permission_denied",
  "vault_reveal_requires_human",
  "vault_policy_outside_parent",
  "encryption_key_missing",
  "provider_auth_invalid",
  "provider_auth_expired",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_conflict",
  "provider_locked",
  "provider_inventory_incomplete",
  "provider_outcome_unknown",
  "variable_sets_removed",
  "secret_save_forbidden",
  "invalid_secret_name",
  "secret_value_too_large",
  "human_auth_required",
  "secret_search_cursor_invalid",
]);

/**
 * The vault error code of a failed call, from either `{error: {code}}` or the
 * vault routes' `{error: "<code>", message}` body. Null for anything else.
 */
export function vaultErrorCode(error: unknown): VaultErrorCode | null {
  if (!error || typeof error !== "object") return null;
  const record = error as { code?: unknown; body?: unknown; details?: unknown };
  if (typeof record.code === "string" && VAULT_ERROR_CODES.has(record.code)) {
    return record.code as VaultErrorCode;
  }
  if (typeof record.body === "string" && record.body) {
    try {
      const parsed = JSON.parse(record.body) as { error?: unknown };
      const candidate =
        typeof parsed.error === "string"
          ? parsed.error
          : parsed.error && typeof parsed.error === "object"
            ? (parsed.error as { code?: unknown }).code
            : undefined;
      if (typeof candidate === "string" && VAULT_ERROR_CODES.has(candidate)) {
        return candidate as VaultErrorCode;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** Server-side detail of a vault error (for example `retryAt` on a rate limit). */
export function vaultErrorDetail(error: unknown, key: string): unknown {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { details?: Record<string, unknown>; body?: unknown };
  if (record.details && key in record.details) return record.details[key];
  if (typeof record.body === "string" && record.body) {
    try {
      const parsed = JSON.parse(record.body) as Record<string, unknown>;
      const nested =
        parsed.error && typeof parsed.error === "object"
          ? (parsed.error as Record<string, unknown>)
          : parsed;
      const details = (nested.details ?? parsed.details) as Record<string, unknown> | undefined;
      return details?.[key] ?? nested[key];
    } catch {
      return undefined;
    }
  }
  return undefined;
}
