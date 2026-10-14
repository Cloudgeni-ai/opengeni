import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionMetadata } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { isWorkspacePermissionDenied } from "@/lib/permissions";

/** Settings inventory uses the same owning-human authority as the session picker,
 * with inactive accounts included for repair. It never feeds credential selection. */
export function useCatalogConnectionAccounts(
  client: OpenGeniBrowserClient,
  workspaceId: string,
  authorityKey: string,
  canRead: boolean | null,
  enabled: boolean,
  catalogRevision: number,
) {
  const scope = useRef({ client, workspaceId, authorityKey, canRead, enabled, epoch: 0 });
  if (
    scope.current.client !== client ||
    scope.current.workspaceId !== workspaceId ||
    scope.current.authorityKey !== authorityKey ||
    scope.current.canRead !== canRead ||
    scope.current.enabled !== enabled
  )
    scope.current.epoch++;
  scope.current = {
    client,
    workspaceId,
    authorityKey,
    canRead,
    enabled,
    epoch: scope.current.epoch,
  };
  const epoch = scope.current.epoch;
  const [result, setResult] = useState<{
    epoch: number;
    connections: ConnectionMetadata[] | null;
    loadFailed: boolean;
    accessDenied: boolean;
  } | null>(null);
  const request = useRef(0);
  const successfulRequest = useRef(0);
  const deniedRequest = useRef(0);
  const refresh = useCallback(async () => {
    if (scope.current.epoch !== epoch || canRead !== true || !enabled) return;
    const revision = ++request.current;
    const live = () => scope.current.epoch === epoch;
    try {
      const connections = await client.listOwnConnectionAccounts(workspaceId, {
        includeInactive: true,
      });
      if (live() && revision > successfulRequest.current && revision > deniedRequest.current) {
        successfulRequest.current = revision;
        setResult({ epoch, connections, loadFailed: false, accessDenied: false });
      }
    } catch (failure) {
      const denied = isWorkspacePermissionDenied(failure);
      // Any confirmed denial newer than the last success hides cached rows,
      // even while a later request is pending. Only a later success restores them.
      if (
        live() &&
        denied &&
        revision > successfulRequest.current &&
        revision > deniedRequest.current
      ) {
        deniedRequest.current = revision;
        setResult({ epoch, connections: null, loadFailed: true, accessDenied: true });
      } else if (live() && request.current === revision && revision > successfulRequest.current) {
        setResult({
          epoch,
          connections: null,
          loadFailed: true,
          accessDenied: deniedRequest.current > successfulRequest.current,
        });
      }
    }
  }, [client, workspaceId, epoch, canRead, enabled]);
  useEffect(() => {
    void refresh();
    const counter = request;
    return () => {
      counter.current++;
    };
  }, [refresh, catalogRevision]);
  const visible = canRead === true && result?.epoch === epoch ? result : null;
  return {
    connections: visible?.connections ?? null,
    loadFailed: visible?.loadFailed ?? false,
    accessDenied: canRead === false || (visible?.accessDenied ?? false),
    onRetry: () => {
      void refresh();
    },
  };
}
