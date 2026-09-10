import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type {
  CapabilityCatalogItem,
  McpConnectionAuthoritySelection,
  Session,
} from "@opengeni/sdk";

export function useSessionConnectionAuthorities(
  client: OpenGeniBrowserClient,
  session: Session,
  catalog: CapabilityCatalogItem[],
) {
  const identity = `${session.workspaceId}:${session.id}:${session.tenancy?.visibility}:${session.tenancy?.authorityEpoch}`;
  const selectedIds =
    session.effectiveToolPolicy?.selectedIds ?? session.tools.map((tool) => tool.id);
  const selectedKey = selectedIds.join("\u0000");
  const scope = useRef({ client, identity, catalog, selectedKey, session });
  scope.current = { client, identity, catalog, selectedKey, session };
  const [result, setResult] = useState<{
    client: OpenGeniBrowserClient;
    identity: string;
    catalog: CapabilityCatalogItem[];
    selectedKey: string;
    selections: McpConnectionAuthoritySelection[];
    error: string | null;
  } | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const invocation = scope.current;
    const revision = ++request.current;
    const current = () =>
      request.current === revision &&
      scope.current.client === invocation.client &&
      scope.current.identity === invocation.identity &&
      scope.current.catalog === invocation.catalog &&
      scope.current.selectedKey === invocation.selectedKey;
    try {
      const selected = new Set(invocation.selectedKey.split("\u0000"));
      const { sessionConnectionAuthorities } = await import("./session-connection-authority");
      const selections = await sessionConnectionAuthorities(
        invocation.client,
        invocation.session,
        invocation.catalog.filter(
          (item) => item.runtime.mcpServerId && selected.has(item.runtime.mcpServerId),
        ),
      );
      if (current()) setResult({ ...invocation, selections, error: null });
    } catch (failure) {
      if (current())
        setResult({
          ...invocation,
          selections: [],
          error:
            failure instanceof Error
              ? failure.message
              : "Personal connection access could not be checked.",
        });
    }
    // The snapshot only depends on session identity/authority and selected tools.
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
  const hasPersonal = catalog.some(
    (item) =>
      item.enabled &&
      item.connectionRef?.subjectScope === "subject" &&
      item.runtime.mcpServerId &&
      selectedIds.includes(item.runtime.mcpServerId),
  );
  return {
    selections: matches ? result.selections : [],
    error: matches ? result.error : null,
    loading: hasPersonal && !matches,
    refresh,
  };
}
