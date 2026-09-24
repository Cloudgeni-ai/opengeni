import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { CapabilityCatalogItem, Session } from "@opengeni/sdk";
import { isWorkspacePermissionDenied } from "@/lib/permissions";
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
  initialChoices: ConnectionAccountChoices = {},
) {
  const identity = `${session.workspaceId}:${session.id}`;
  const selectedIds = session.selectedIds;
  const scope = useRef({ client, identity, catalog, session });
  scope.current = { client, identity, catalog, session };
  const [choices, setChoices] = useState<{
    client: OpenGeniBrowserClient;
    identity: string;
    accounts: ConnectionAccountChoices;
  } | null>(null);
  const [result, setResult] = useState<{
    client: OpenGeniBrowserClient;
    identity: string;
    catalog: CapabilityCatalogItem[];
    groups: ConnectedAccountGroup[];
    error: string | null;
    accessDenied: boolean;
  } | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const invocation = scope.current;
    const revision = ++request.current;
    setResult(null);
    const current = () =>
      request.current === revision &&
      scope.current.client === invocation.client &&
      scope.current.identity === invocation.identity &&
      scope.current.catalog === invocation.catalog;
    try {
      const groups = await sessionConnectedAccounts(
        invocation.client,
        invocation.session.workspaceId,
        invocation.catalog,
      );
      if (current()) setResult({ ...invocation, groups, error: null, accessDenied: false });
    } catch (failure) {
      if (current()) {
        const accessDenied = isWorkspacePermissionDenied(failure);
        setResult({
          ...invocation,
          groups: [],
          error: accessDenied
            ? "You don't have permission to view connection accounts. Ask a workspace admin for connection access."
            : failure instanceof Error
              ? failure.message
              : "Connection accounts could not be checked.",
          accessDenied,
        });
      }
    }
    // Inventory stays available when a connector is toggled off. Selection is
    // projected separately, without a refetch that removes the settings control.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, identity, catalog]);
  useEffect(() => {
    const counter = request;
    void refresh();
    return () => {
      counter.current++;
    };
  }, [refresh]);
  const matches =
    result?.client === client && result.identity === identity && result.catalog === catalog;
  const hasNative = catalog.some(
    (item) =>
      item.enabled &&
      item.connectionRef &&
      item.connectionRef.authoritySource !== "host" &&
      item.runtime.mcpServerId &&
      selectedIds.includes(item.runtime.mcpServerId),
  );
  const accountChoices =
    choices?.client === client && choices.identity === identity ? choices.accounts : initialChoices;
  const accountGroups = matches
    ? result.groups.filter((group) => selectedIds.includes(group.serverId))
    : [];
  const selection = selectedConnectionAccounts(accountGroups, accountChoices);
  return {
    selections: selection.selections,
    accountGroups,
    availableAccountGroups: matches ? result.groups : [],
    accountChoices,
    resetEmptyChoices: () =>
      setChoices({
        client,
        identity,
        accounts: Object.fromEntries(
          Object.entries(accountChoices).filter(([, ids]) => ids.length > 0),
        ),
      }),
    requiresAccountChoice: selection.unresolved.length > 0,
    accountChoiceMessage: selection.unresolved.length
      ? `Review accounts for ${selection.unresolved.map((group) => group.name).join(", ")} in + → Connectors. Select an available account or turn off the connector for this chat.`
      : null,
    selectAccount: (serverId: string, connectionIds: string[]) =>
      setChoices((current) => ({
        client,
        identity,
        accounts: {
          ...(current?.client === client && current.identity === identity
            ? current.accounts
            : initialChoices),
          [serverId]: connectionIds,
        },
      })),
    error: matches && hasNative ? result.error : null,
    accessDenied: Boolean(matches && hasNative && result.accessDenied),
    loading: hasNative && !matches,
    refresh,
  };
}
