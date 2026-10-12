import type { SuperGrokAccount, SuperGrokAccountsResponse } from "@opengeni/sdk";
import { useCallback } from "react";

import { useOpenGeni, type ClientOverride } from "../provider";
import { useMutationRunner } from "./internal";
import { invalidateSharedQueries, useSharedQuery, type SharedQueryKey } from "./shared-query";

/** Shared-cache key for a workspace's SuperGrok accounts (internal; see `useSharedQuery`). */
export const superGrokAccountsQueryKey = (workspaceId: string) =>
  ["supergrok-accounts", workspaceId] as SharedQueryKey;

export type SuperGrokAccountsClientLike = {
  listSuperGrokAccounts: (workspaceId: string) => Promise<SuperGrokAccountsResponse>;
  activateSuperGrokAccount?: (
    workspaceId: string,
    accountId: string,
  ) => Promise<{ activated: boolean; accountId: string }>;
};

export type UseSuperGrokAccountsOptions = ClientOverride & {
  enabled?: boolean | undefined;
  pollIntervalMs?: number | undefined;
  supergrokClient?: SuperGrokAccountsClientLike | undefined;
};

export type UseSuperGrokAccountsResult = {
  accounts: SuperGrokAccount[];
  activeAccountId: string | null;
  settings: SuperGrokAccountsResponse["settings"];
  loading: boolean;
  refresh: () => Promise<void>;
  activate: (accountId: string) => Promise<boolean>;
  activating: boolean;
  mutationError: Error | null;
};

const EMPTY: SuperGrokAccountsResponse = {
  accounts: [],
  activeAccountId: null,
  settings: {
    rotationEnabled: false,
    rotationStrategy: "sharded",
    activeCredentialId: null,
  },
};

/**
 * Workspace-visible xAI accounts. Workspace scope is the connection default.
 * Reads share the client-scoped cache, so a remount renders retained rows at once.
 */
export function useSuperGrokAccounts(
  options: UseSuperGrokAccountsOptions = {},
): UseSuperGrokAccountsResult {
  const { client, workspaceId } = useOpenGeni(options);
  const supergrokClient =
    options.supergrokClient ?? (client as unknown as SuperGrokAccountsClientLike);
  const load = useCallback(
    async () => await supergrokClient.listSuperGrokAccounts(workspaceId),
    [supergrokClient, workspaceId],
  );
  const { data, loading, refresh } = useSharedQuery(
    supergrokClient,
    superGrokAccountsQueryKey(workspaceId),
    load,
    { enabled: options.enabled, pollIntervalMs: options.pollIntervalMs },
  );
  const { run, mutating: activating, mutationError } = useMutationRunner();
  const activate = useCallback(
    async (accountId: string): Promise<boolean> => {
      if (!supergrokClient.activateSuperGrokAccount) return false;
      const invalidated: { current: Promise<void> | null } = { current: null };
      const result = await run(async () => {
        await supergrokClient.activateSuperGrokAccount!(workspaceId, accountId);
        // Invalidate even if this component unmounted meanwhile (the runner
        // then resolves null): other surfaces must not keep the old primary.
        invalidated.current = invalidateSharedQueries(supergrokClient, ["supergrok-accounts"]);
        return true;
      });
      if (result) await invalidated.current;
      return result === true;
    },
    [run, supergrokClient, workspaceId],
  );
  const state = data ?? EMPTY;
  return {
    accounts: state.accounts,
    activeAccountId: state.activeAccountId,
    settings: state.settings,
    loading,
    refresh,
    activate,
    activating,
    mutationError,
  };
}
