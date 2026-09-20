import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { CapabilityCatalogItem, Session } from "@opengeni/sdk";
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
  const selectedKey = selectedIds.join("\u0000");
  const scope = useRef({ client, identity, catalog, selectedKey, session });
  scope.current = { client, identity, catalog, selectedKey, session };
  const [choices, setChoices] = useState<{
    client: OpenGeniBrowserClient;
    identity: string;
    accounts: ConnectionAccountChoices;
  } | null>(null);
  const [result, setResult] = useState<{
    client: OpenGeniBrowserClient;
    identity: string;
    catalog: CapabilityCatalogItem[];
    selectedKey: string;
    groups: ConnectedAccountGroup[];
    error: string | null;
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
      scope.current.catalog === invocation.catalog &&
      scope.current.selectedKey === invocation.selectedKey;
    try {
      const selected = new Set(invocation.selectedKey.split("\u0000"));
      const groups = await sessionConnectedAccounts(
        invocation.client,
        invocation.session.workspaceId,
        invocation.catalog.filter(
          (item) => item.runtime.mcpServerId && selected.has(item.runtime.mcpServerId),
        ),
      );
      if (current()) setResult({ ...invocation, groups, error: null });
    } catch (failure) {
      if (current())
        setResult({
          ...invocation,
          groups: [],
          error:
            failure instanceof Error
              ? failure.message
              : "Connection accounts could not be checked.",
        });
    }
    // Account inventory depends on caller/session identity and selected tools.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, identity, catalog, selectedKey]);
  useEffect(() => {
    const counter = request;
    void refresh();
    return () => {
      counter.current++;
    };
  }, [refresh]);
  const matches =
    result?.client === client &&
    result.identity === identity &&
    result.catalog === catalog &&
    result.selectedKey === selectedKey;
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
  const selection = selectedConnectionAccounts(matches ? result.groups : [], accountChoices);
  return {
    selections: selection.selections,
    accountGroups: matches ? result.groups : [],
    accountChoices,
    requiresAccountChoice: selection.unresolved.length > 0,
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
    error: matches ? result.error : null,
    loading: hasNative && !matches,
    refresh,
  };
}
