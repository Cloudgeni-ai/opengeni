import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatClient } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { CapabilityCatalogItem, ChatSession as Session } from "@opengeni/sdk";
import type { McpConnectionAccountSelection } from "@opengeni/sdk";
import { isConnectionAccountSubmissionError } from "../../../lib/format";
import { userErrorText } from "../../../ui/api-error";
import { isWorkspacePermissionDenied } from "../../lib/permissions";
import {
  isTransientServiceFailure,
  retryTransient,
  TRANSIENT_RECONNECT_INTERVAL_MS,
  TRANSIENT_RETRY_DELAYS_MS,
} from "../../lib/transient-retry";
import { loadConnectionHealthAccounts } from "../../lib/shared-catalog-reads";
import {
  isLapsedAccount,
  selectedConnectionAccounts,
  sessionConnectedAccounts,
  type ConnectedAccountGroup,
  type ConnectionAccountChoices,
} from "./session-connection-accounts";

/** How old a chat's account list may get before returning to the chat re-reads it. */
export const CONNECTION_ACCOUNTS_STALE_AFTER_MS = 60_000;

/**
 * The accounts a refused send can go again with: its picks minus those that
 * stopped working or are no longer listed, but only where the connector keeps
 * another pick. A connector left with no pick would mean "use its defaults",
 * which could attach accounts the person did not pick, so its picks are sent
 * as they were. Null when nothing can be dropped this way: the refusal stands.
 */
export function accountsWithoutUnusablePicks(
  sent: readonly McpConnectionAccountSelection[],
  groups: readonly ConnectedAccountGroup[],
): McpConnectionAccountSelection[] | null {
  const usable = (selection: McpConnectionAccountSelection) =>
    groups.some(
      (group) =>
        group.serverId === selection.serverId &&
        group.accounts.some(
          (account) => account.id === selection.connectionId && !isLapsedAccount(account),
        ),
    );
  const kept = sent.filter(
    (selection) =>
      usable(selection) ||
      // Its connector's last usable pick is gone: dropping would widen.
      !sent.some((other) => other.serverId === selection.serverId && usable(other)),
  );
  if (kept.length === sent.length) return null;
  return kept;
}

export function useConnectionAccounts(
  client: ChatClient<OpenGeniBrowserClient>,
  session: Pick<Session, "id" | "workspaceId"> & { selectedIds: string[] },
  catalog: CapabilityCatalogItem[],
  canReadConnections: boolean | null,
  initialChoices: ConnectionAccountChoices = {},
  transientRetry: {
    delaysMs?: readonly number[] | undefined;
    reconnectIntervalMs?: number | undefined;
  } = {},
  /** A chat left open re-reads its accounts on return after this long. */
  staleAfterMs = CONNECTION_ACCOUNTS_STALE_AFTER_MS,
) {
  const retryDelaysMs = transientRetry.delaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  const reconnectIntervalMs = transientRetry.reconnectIntervalMs ?? TRANSIENT_RECONNECT_INTERVAL_MS;
  const identity = `${session.workspaceId}:${session.id}`;
  const selectedIds = session.selectedIds;
  const scope = useRef({ client, identity, catalog, session, canReadConnections, epoch: 0 });
  // A new caller, chat or grant fences old inventory. A refreshed catalog does
  // not: the last inventory stays on screen while the new one loads, so menus
  // and the page never flash back to a loading state.
  if (
    scope.current.client !== client ||
    scope.current.identity !== identity ||
    scope.current.canReadConnections !== canReadConnections
  ) {
    scope.current.epoch++;
  }
  scope.current = {
    client,
    identity,
    catalog,
    session,
    canReadConnections,
    epoch: scope.current.epoch,
  };
  const epoch = scope.current.epoch;
  const [choices, setChoices] = useState<{
    client: ChatClient<OpenGeniBrowserClient>;
    identity: string;
    epoch: number;
    accounts: ConnectionAccountChoices;
  } | null>(null);
  const [result, setResult] = useState<{
    client: ChatClient<OpenGeniBrowserClient>;
    identity: string;
    epoch: number;
    catalog: CapabilityCatalogItem[];
    groups: ConnectedAccountGroup[];
    error: string | null;
    accessDenied: boolean;
    /** The inventory read kept failing because Opengeni was briefly unreachable. */
    unavailable: boolean;
  } | null>(null);
  const request = useRef(0);
  /** When the last inventory read started, for re-reading a stale one on return. */
  const lastRead = useRef(0);
  /** Only the hook's first read may reuse a recent one; later reads follow a change. */
  const firstReadStarted = useRef(false);
  const refresh = useCallback(
    async (quietRetries = true, reuseRecent = false): Promise<ConnectedAccountGroup[] | null> => {
      if (scope.current.epoch !== epoch) return null;
      const invocation = scope.current;
      if (invocation.canReadConnections !== true) return null;
      const reuse = reuseRecent && !firstReadStarted.current;
      firstReadStarted.current = true;
      const revision = ++request.current;
      lastRead.current = Date.now();
      const current = () =>
        request.current === revision &&
        scope.current.client === invocation.client &&
        scope.current.identity === invocation.identity &&
        scope.current.epoch === invocation.epoch &&
        scope.current.canReadConnections === true;
      try {
        // A deploy or database restart answers 502/503 for a few seconds: retry
        // quietly before telling anyone the accounts could not be checked.
        const groups = await retryTransient(
          () =>
            sessionConnectedAccounts(
              invocation.client,
              invocation.session.workspaceId,
              invocation.catalog,
              undefined,
              // The client's shared account read, which the composer also uses.
              async () =>
                await loadConnectionHealthAccounts(
                  invocation.client,
                  invocation.session.workspaceId,
                  { reuseRecent: reuse },
                ),
            ),
          { shouldContinue: current, delaysMs: quietRetries ? retryDelaysMs : [] },
        );
        if (current()) {
          setResult({
            ...invocation,
            groups,
            error: null,
            accessDenied: false,
            unavailable: false,
          });
          return groups;
        }
        return null;
      } catch (failure) {
        if (current()) {
          const accessDenied = isWorkspacePermissionDenied(failure);
          if (accessDenied) setChoices(null);
          setResult({
            ...invocation,
            groups: [],
            error: accessDenied
              ? "You don't have permission to view connection accounts. Ask a workspace admin for connection access."
              : `Couldn't check connected accounts. ${userErrorText(failure)}`,
            accessDenied,
            unavailable: !accessDenied && isTransientServiceFailure(failure),
          });
        }
        return null;
      }
    },
    // Inventory stays available when a connector is toggled off. Selection is
    // projected separately, without a refetch that removes the settings control.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, identity, catalog, canReadConnections, epoch],
  );
  useEffect(() => {
    const counter = request;
    // The first read may take the composer's, read a moment ago. A re-run
    // after a catalog change reads afresh.
    void refresh(true, true);
    return () => {
      counter.current++;
    };
  }, [refresh]);
  // An account can stop working while the chat sits open (its sign-in
  // expires). Re-read when the person comes back to a chat whose list is
  // old, so the connector shows as needing reconnecting before they send.
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRead.current < staleAfterMs) return;
      void refresh();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [refresh, staleAfterMs]);
  const matches =
    canReadConnections === true &&
    result?.client === client &&
    result.identity === identity &&
    result.epoch === epoch;
  const unavailable = matches && result.unavailable;
  // While Opengeni is unreachable, keep reconnecting in the background; the
  // first successful read clears the state and unblocks Send.
  useEffect(() => {
    if (!unavailable) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      timer = setTimeout(() => {
        if (stopped) return;
        // One attempt per tick: the loop itself is the retry.
        void refresh(false).finally(() => {
          if (!stopped) tick();
        });
      }, reconnectIntervalMs);
    };
    tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [unavailable, refresh, reconnectIntervalMs]);
  const hasNative = catalog.some(
    (item) =>
      item.enabled &&
      item.connectionRef &&
      item.connectionRef.authoritySource !== "host" &&
      item.runtime.mcpServerId &&
      selectedIds.includes(item.runtime.mcpServerId),
  );
  const accountChoices =
    canReadConnections === true && !(matches && result.accessDenied)
      ? choices?.client === client && choices.identity === identity && choices.epoch === epoch
        ? choices.accounts
        : initialChoices
      : {};
  const accountGroups = matches
    ? result.groups.filter((group) => selectedIds.includes(group.serverId))
    : [];
  const selection = selectedConnectionAccounts(accountGroups, accountChoices);
  return {
    selections: selection.selections,
    accountGroups,
    availableAccountGroups: matches ? result.groups : [],
    accountChoices,
    resetEmptyChoices: () => {
      if (scope.current.epoch !== epoch || scope.current.canReadConnections !== true) return;
      setChoices({
        client,
        identity,
        epoch,
        accounts: Object.fromEntries(
          Object.entries(accountChoices).filter(([, ids]) => ids.length > 0),
        ),
      });
    },
    requiresAccountChoice: selection.unresolved.length > 0,
    accountChoiceMessage: selection.unresolved.length
      ? `Review accounts for ${selection.unresolved.map((group) => group.name).join(", ")} in + → Connectors. Select an available account or turn off the connector for this chat.`
      : null,
    selectAccount: (serverId: string, connectionIds: string[]) => {
      if (scope.current.epoch !== epoch || scope.current.canReadConnections !== true) return;
      setChoices((current) => ({
        client,
        identity,
        epoch,
        accounts: {
          ...(current?.client === client && current.identity === identity && current.epoch === epoch
            ? current.accounts
            : initialChoices),
          [serverId]: connectionIds,
        },
      }));
    },
    error: hasNative
      ? canReadConnections === false
        ? "You don't have permission to view connection accounts. Ask a workspace admin for connection access."
        : matches
          ? result.error
          : null
      : null,
    accessDenied: Boolean(
      hasNative && (canReadConnections === false || (matches && result.accessDenied)),
    ),
    /** Opengeni was briefly unreachable; `error` is set and Send stays blocked until it returns. */
    unavailable: Boolean(hasNative && canReadConnections === true && unavailable),
    loading: hasNative && canReadConnections !== false && !matches,
    refresh: async (quietRetries?: boolean): Promise<void> => {
      await refresh(quietRetries);
    },
    // Refresh inventory only. Explicit choices remain pinned; a refused send
    // goes again only through `reviseRefusedAccounts`.
    onSelectionError: (error: unknown) => {
      if (isConnectionAccountSubmissionError(error)) void refresh();
    },
    /**
     * For a send refused over its connector accounts: re-read them and give
     * the picks to send again with, leaving out accounts that stopped working
     * or are no longer listed only where the connector keeps another pick.
     * Never adds, swaps or widens; null keeps the refusal. Only the retry is
     * narrowed: the person's choices stay as they are, so an account they
     * reconnect is picked again.
     */
    reviseRefusedAccounts: async (
      error: unknown,
      sent: readonly McpConnectionAccountSelection[] | undefined,
    ): Promise<McpConnectionAccountSelection[] | null> => {
      if (!isConnectionAccountSubmissionError(error) || !sent?.length) return null;
      const groups = await refresh(false);
      if (!groups) return null;
      const kept = accountsWithoutUnusablePicks(sent, groups);
      return kept;
    },
  };
}
