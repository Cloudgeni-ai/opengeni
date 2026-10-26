/**
 * Event sources as the automation pages read them: whether this deployment
 * runs event triggers at all, the sources the viewer can use, and each
 * source's brand logo from the workspace's capability catalog.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { eventSourceLogoResolver, type EventSourceLogoResolver } from "@opengeni/react/automations";
import { useAppContext } from "@opengeni/react/app/app-context";
import type { EventSource, EventTypeDescriptor, ReadyEventSource } from "@opengeni/sdk";

/** Event triggers run on this deployment; without them the pages show schedules only. */
export function useEventTriggersEnabled(): boolean {
  return useAppContext().clientConfig.eventTriggers?.enabled === true;
}

export type EventSourcesState = {
  /** Undefined until the first read settles. */
  sources: EventSource[] | undefined;
  error: Error | null;
  reload: () => void;
  /** Reads one source's event types, for the trigger editor. */
  loadEventTypes: (sourceId: string) => Promise<EventTypeDescriptor[]>;
};

/** The workspace's event sources the viewer can see, read once while `enabled`. */
export function useEventSources(workspaceId: string, enabled: boolean): EventSourcesState {
  const { client } = useAppContext();
  const [sources, setSources] = useState<EventSource[] | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    client.listEventSources(workspaceId).then(
      (next) => {
        if (!live) return;
        setSources(next);
        setError(null);
      },
      (reason: unknown) => {
        if (!live) return;
        setError(reason instanceof Error ? reason : new Error(String(reason)));
        setSources((current) => current ?? []);
      },
    );
    return () => {
      live = false;
    };
  }, [attempt, client, enabled, workspaceId]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const loadEventTypes = useCallback(
    (sourceId: string) => client.listEventSourceTypes(workspaceId, sourceId),
    [client, workspaceId],
  );
  return { sources: enabled ? sources : [], error, reload, loadEventTypes };
}

/**
 * Sources the viewer can use without setting them up, such as an MCP server
 * they are signed in to that offers events. Empty until known, and on failure:
 * the sources they have are still offered.
 */
export function useReadyEventSources(workspaceId: string, enabled: boolean): ReadyEventSource[] {
  const { client } = useAppContext();
  const [ready, setReady] = useState<ReadyEventSource[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    client.listReadyEventSources(workspaceId).then(
      (next) => {
        if (live) setReady(next);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, enabled, workspaceId]);
  return enabled ? ready : [];
}

/**
 * The brand logo for a source: its app's logo for GitHub, Slack, Gmail, Linear
 * and Sentry, the MCP server's own logo for an MCP source.
 */
export function useEventSourceLogo(): EventSourceLogoResolver {
  const { client, workspaceCapabilityCatalog } = useAppContext();
  return useMemo(
    () =>
      eventSourceLogoResolver(workspaceCapabilityCatalog, (path) => client.catalogAssetUrl(path)),
    [client, workspaceCapabilityCatalog],
  );
}
