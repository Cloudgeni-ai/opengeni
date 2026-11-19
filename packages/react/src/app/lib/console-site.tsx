import type { SiteViewer } from "@opengeni/sdk";
import { useCallback, useMemo } from "react";
import type { SiteToolBridgeFactory } from "../../artifacts";
import { useAppContext } from "../app-context";
import { useAppApi } from "./app-api";
import { createSiteToolBridge } from "./site-tool-bridge";
import { useSiteToolConsentHost } from "./site-tool-consent";

/** The signed-in member as Site code sees them (`site.viewer`) in the console. */
export function useConsoleSiteViewer(): SiteViewer {
  const { accessContext, authSession } = useAppContext();
  const subjectId = accessContext.subjectId;
  const name = authSession?.user?.name ?? null;
  const email = authSession?.user?.email ?? null;
  return useMemo(
    () => ({ kind: "member", id: `user:${subjectId}`, name, email, signedIn: true }),
    [email, name, subjectId],
  );
}

/** Listeners per Site for changes the console makes to what its viewer can do. */
const readinessListeners = new Map<string, Set<() => void>>();

/** Tell every open frame of this Site that what the viewer can do may have changed. */
export function notifySiteToolReadinessChanged(siteId: string): void {
  for (const listener of [...(readinessListeners.get(siteId) ?? [])]) {
    try {
      listener();
    } catch {
      // One frame's failure must not stop the others.
    }
  }
}

function subscribeSiteToolReadiness(siteId: string, listener: () => void): () => void {
  const listeners = readinessListeners.get(siteId) ?? new Set<() => void>();
  listeners.add(listener);
  readinessListeners.set(siteId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) readinessListeners.delete(siteId);
  };
}

/** Console tool access for a `SiteView`, pinned to the loaded Site version. */
export function useConsoleSiteToolBridge(workspaceId: string): SiteToolBridgeFactory {
  const { client } = useAppContext();
  const api = useAppApi();
  const consent = useSiteToolConsentHost();
  return useCallback<SiteToolBridgeFactory>(
    (site) => {
      const scope = { workspaceTools: client.tools.forWorkspace(workspaceId), workspaceId };
      return site
        ? createSiteToolBridge(api, {
            ...scope,
            artifactId: site.artifactId,
            siteVersionId: site.siteVersionId,
            requestedTools: site.requestedTools,
            consent,
            readinessChanges: (listener) => subscribeSiteToolReadiness(site.artifactId, listener),
          })
        : createSiteToolBridge(api, scope);
    },
    [api, client, consent, workspaceId],
  );
}
