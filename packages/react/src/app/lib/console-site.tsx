import type { SiteViewer } from "@opengeni/sdk";
import { useCallback, useMemo } from "react";
import type { SiteToolBridgeFactory } from "../../artifacts";
import { useAppContext } from "../app-context";
import { useAppApi } from "./app-api";
import { requestSiteSyncOptIn } from "./app-sync-opt-in";
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

export function subscribeSiteToolReadiness(siteId: string, listener: () => void): () => void {
  const listeners = readinessListeners.get(siteId) ?? new Set<() => void>();
  listeners.add(listener);
  readinessListeners.set(siteId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) readinessListeners.delete(siteId);
  };
}

/** Connect cards on screen per App; the App's `site.connections.showCard()` brings them back. */
const connectCardListeners = new Map<string, Set<() => void>>();

/** Show this App's connect card again (even if closed); false when no card is on screen. */
export function showSiteConnectCard(siteId: string): boolean {
  const listeners = [...(connectCardListeners.get(siteId) ?? [])];
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // One card's failure must not stop the others.
    }
  }
  return listeners.length > 0;
}

export function subscribeSiteConnectCardShow(siteId: string, listener: () => void): () => void {
  const listeners = connectCardListeners.get(siteId) ?? new Set<() => void>();
  listeners.add(listener);
  connectCardListeners.set(siteId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) connectCardListeners.delete(siteId);
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
            consent: consent && {
              ...consent,
              // The App's own `site.connections.connect()` also refreshes its card.
              connectForToolCall: async (prompt) => {
                const done = await consent.connectForToolCall(prompt);
                if (done) notifySiteToolReadinessChanged(site.artifactId);
                return done;
              },
              recoverToolCall: async (prompt) => {
                const again = await consent.recoverToolCall(prompt);
                if (again && prompt.failure.reconnect)
                  notifySiteToolReadinessChanged(site.artifactId);
                return again;
              },
            },
            readinessChanges: (listener) => subscribeSiteToolReadiness(site.artifactId, listener),
            connectCard: { show: () => showSiteConnectCard(site.artifactId) },
            // The platform's own confirmation posts the opt-in, never the App.
            syncOptIn: ({ syncId, optedIn }, { signal }) =>
              requestSiteSyncOptIn(site.artifactId, syncId, optedIn, signal),
          })
        : createSiteToolBridge(api, scope);
    },
    [api, client, consent, workspaceId],
  );
}
