import { useCallback, useMemo } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import type {
  ListVaultItemsQuery,
  SessionSecretsView,
  VaultFieldVersionMeta,
  VaultItem,
  VaultItemSummary,
  VaultSummary,
} from "../types/vaults";
import { asVaultClient, vaultsApi, type VaultsApi } from "../vaults";
import { usePolledValue } from "./internal";

export type UseVaultQueryOptions = ClientOverride & {
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

type QueryResult<T> = {
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
} & T;

/**
 * The workspace's vault REST surface for the current client. Mutations are
 * plain promises: callers refresh the affected query afterwards. Plaintext
 * (`revealField`) is returned to the caller only and never stored here.
 */
export function useVaultsApi(options: ClientOverride = {}): VaultsApi {
  const { client, workspaceId } = useOpenGeni(options);
  return useMemo(() => vaultsApi(asVaultClient(client), workspaceId), [client, workspaceId]);
}

/** Vaults the caller can see in this workspace (metadata only). */
export function useVaults(
  options: UseVaultQueryOptions = {},
): QueryResult<{ vaults: VaultSummary[] | null; api: VaultsApi }> {
  const api = useVaultsApi(options);
  const load = useCallback((signal?: AbortSignal) => api.listVaults(signal), [api]);
  const { data, loading, error, refresh } = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  return { vaults: data, loading, error, refresh, api };
}

/** One vault's metadata. */
export function useVault(
  vaultId: string,
  options: UseVaultQueryOptions = {},
): QueryResult<{ vault: VaultSummary | null; api: VaultsApi }> {
  const api = useVaultsApi(options);
  const load = useCallback((signal?: AbortSignal) => api.getVault(vaultId, signal), [api, vaultId]);
  const { data, loading, error, refresh } = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  return { vault: data, loading, error, refresh, api };
}

const ITEM_PAGE_LIMIT = 500;

/**
 * A vault's items (metadata only). Follows cursors so a dense vault renders
 * as one virtualized list; `q`/`type` filter server-side.
 */
export function useVaultItems(
  vaultId: string,
  query: ListVaultItemsQuery = {},
  options: UseVaultQueryOptions = {},
): QueryResult<{ items: VaultItemSummary[] | null; api: VaultsApi }> {
  const api = useVaultsApi(options);
  const { q, type, includeArchived } = query;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const items: VaultItemSummary[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 40; page += 1) {
        const result = await api.listItems(
          vaultId,
          { q, type, includeArchived, cursor, limit: ITEM_PAGE_LIMIT },
          signal,
        );
        items.push(...result.items);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return items;
    },
    [api, vaultId, q, type, includeArchived],
  );
  const { data, loading, error, refresh } = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  return { items: data, loading, error, refresh, api };
}

/** One item with its fields' metadata (concealed values are never included). */
export function useVaultItem(
  vaultId: string,
  itemId: string,
  options: UseVaultQueryOptions = {},
): QueryResult<{ item: VaultItem | null; api: VaultsApi }> {
  const api = useVaultsApi(options);
  const load = useCallback(
    (signal?: AbortSignal) => api.getItem(vaultId, itemId, signal),
    [api, vaultId, itemId],
  );
  const { data, loading, error, refresh } = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  return { item: data, loading, error, refresh, api };
}

/** A field's version history (metadata only). */
export function useVaultFieldVersions(
  vaultId: string,
  itemId: string,
  fieldId: string,
  options: UseVaultQueryOptions = {},
): QueryResult<{ versions: VaultFieldVersionMeta[] | null }> {
  const api = useVaultsApi(options);
  const load = useCallback(
    (signal?: AbortSignal) => api.listFieldVersions(vaultId, itemId, fieldId, signal),
    [api, vaultId, itemId, fieldId],
  );
  const { data, loading, error, refresh } = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  return { versions: data, loading, error, refresh };
}

/** A session's secrets view: policy, reachable vaults and its task vault. */
export function useSessionSecrets(
  sessionId: string | null | undefined,
  options: UseVaultQueryOptions = {},
): QueryResult<{ secrets: SessionSecretsView | null; api: VaultsApi }> {
  const api = useVaultsApi(options);
  const load = useCallback(
    (signal?: AbortSignal) => api.getSessionSecrets(sessionId ?? "", signal),
    [api, sessionId],
  );
  const { data, loading, error, refresh } = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: (options.enabled ?? true) && !!sessionId,
  });
  return { secrets: data, loading, error, refresh, api };
}
