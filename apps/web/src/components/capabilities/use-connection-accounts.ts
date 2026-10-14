import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { CapabilityCatalogItem, Session } from "@opengeni/sdk";
import { userErrorText } from "@/lib/api-error";
import { isWorkspacePermissionDenied } from "@/lib/permissions";
import {
  isTransientServiceFailure,
  retryTransient,
  TRANSIENT_RECONNECT_INTERVAL_MS,
  TRANSIENT_RETRY_DELAYS_MS,
} from "@/lib/transient-retry";
import {
  selectedConnectionAccounts,
  sessionConnectedAccounts,
  type ConnectedAccountGroup,
  type ConnectionAccountChoices,
} from "./session-connection-accounts";

export function useConnectionAccounts(
  client: OpenGeniBrowserClient,
  session: Pick<Session, "id" | "workspaceId"> & { selectedIds: string[] },
  catalog: CapabilityCatalogItem[],
  canReadConnections: boolean | null,
  initialChoices: ConnectionAccountChoices = {},
  transientRetry: { delaysMs?: readonly number[]; reconnectIntervalMs?: number } = {},
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
    client: OpenGeniBrowserClient;
    identity: string;
    epoch: number;
    accounts: ConnectionAccountChoices;
  } | null>(null);
  const [result, setResult] = useState<{
    client: OpenGeniBrowserClient;
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
  const refresh = useCallback(
    async (quietRetries = true) => {
      if (scope.current.epoch !== epoch) return;
      const invocation = scope.current;
      if (invocation.canReadConnections !== true) return;
      const revision = ++request.current;
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
        }
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
      }
    },
    // Inventory stays available when a connector is toggled off. Selection is
    // projected separately, without a refetch that removes the settings control.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, identity, catalog, canReadConnections, epoch],
  );
  useEffect(() => {
    const counter = request;
    void refresh();
    return () => {
      counter.current++;
    };
  }, [refresh]);
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
    refresh,
  };
}
