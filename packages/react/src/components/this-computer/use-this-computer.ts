import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ThisComputerHost,
  ThisComputerPermissionId,
  ThisComputerStatus,
} from "@opengeni/sdk/this-computer";

export interface UseThisComputerResult {
  /** Null until the first reading, and outside a desktop app. */
  status: ThisComputerStatus | null;
  /** An action from these screens is in progress. */
  acting: boolean;
  /** The last action's failure from these screens, if the host didn't report one. */
  actionError: string | null;
  /** The app can turn this computer off for the workspace. */
  canDisconnect: boolean;
  refresh(): void;
  connect(options: { screenControl: boolean }): Promise<ThisComputerStatus | null>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  disconnect(): Promise<void>;
  requestPermission(id: ThisComputerPermissionId): Promise<void>;
}

/** The bridge's error text without Electron's IPC prefix. */
export function hostErrorText(caught: unknown): string | null {
  if (!(caught instanceof Error) || !caught.message) return null;
  return caught.message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/u, "");
}

/**
 * Where this computer stands for the workspace, kept current: the host says
 * when something changes, and the window coming back to the front reads it
 * again (permissions are granted in System Settings, outside the app).
 */
export function useThisComputer(
  host: ThisComputerHost | null | undefined,
  workspaceId: string,
  options: { pollMs?: number } = {},
): UseThisComputerResult {
  const [status, setStatus] = useState<ThisComputerStatus | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const live = useRef(true);
  const generation = useRef(0);
  const actionInFlight = useRef(false);
  /** The read in flight, and whether another was asked for meanwhile. */
  const reading = useRef<{ generation: number; again: boolean } | null>(null);

  // One read at a time, each result applied: a read can take longer than the
  // polling interval (the host may check permissions with the system), and
  // superseding reads would then never show a change. A read asked for while
  // one is in flight runs once it is done.
  const refresh = useCallback(() => {
    if (!host) return;
    const inFlight = reading.current;
    if (inFlight && inFlight.generation === generation.current) {
      inFlight.again = true;
      return;
    }
    const mine = { generation: generation.current, again: false };
    reading.current = mine;
    void host
      .status(workspaceId)
      .then((next) => {
        if (live.current && mine.generation === generation.current)
          setStatus((current) => sameStatus(current, next));
      })
      .catch(() => undefined)
      .finally(() => {
        if (reading.current !== mine) return;
        reading.current = null;
        if (mine.again && live.current) refreshRef.current();
      });
  }, [host, workspaceId]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    live.current = true;
    // Results for an earlier host or workspace no longer apply.
    generation.current += 1;
    setStatus(null);
    setActionError(null);
    refresh();
    if (!host) return;
    const unsubscribe = host.onChange(refresh);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      live.current = false;
      unsubscribe();
      window.removeEventListener("focus", onFocus);
    };
  }, [host, refresh]);

  const pollMs = options.pollMs;
  useEffect(() => {
    if (!host || !pollMs) return;
    const timer = window.setInterval(refresh, pollMs);
    return () => window.clearInterval(timer);
  }, [host, pollMs, refresh]);

  const act = useCallback(async <T>(action: () => Promise<T>): Promise<T | null> => {
    if (actionInFlight.current) return null;
    actionInFlight.current = true;
    const mine = generation.current;
    setActing(true);
    setActionError(null);
    try {
      const result = await action();
      return live.current && mine === generation.current ? result : null;
    } catch (caught) {
      if (live.current && mine === generation.current) setActionError(hostErrorText(caught) ?? "");
      return null;
    } finally {
      actionInFlight.current = false;
      if (live.current) setActing(false);
      refreshRef.current();
    }
  }, []);

  const connect = useCallback(
    async (connectOptions: { screenControl: boolean }) => {
      if (!host) return null;
      const next = await act(() => host.connect(workspaceId, connectOptions));
      if (next && live.current) setStatus((current) => sameStatus(current, next));
      return next;
    },
    [act, host, workspaceId],
  );
  const pause = useCallback(async () => {
    if (host) await act(() => host.pause());
  }, [act, host]);
  const resume = useCallback(async () => {
    if (host) await act(() => host.resume());
  }, [act, host]);
  const disconnect = useCallback(async () => {
    if (host?.disconnect) await act(() => host.disconnect!(workspaceId));
  }, [act, host, workspaceId]);
  const requestPermission = useCallback(
    async (id: ThisComputerPermissionId) => {
      if (!host?.requestPermission) return;
      await host.requestPermission(id).catch(() => undefined);
      refresh();
    },
    [host, refresh],
  );
  const canDisconnect = Boolean(host?.disconnect);

  // Stable while nothing changes, so a host can put it in context without
  // re-rendering everything below on every status poll.
  return useMemo(
    () => ({
      status,
      acting,
      actionError,
      canDisconnect,
      refresh,
      connect,
      pause,
      resume,
      disconnect,
      requestPermission,
    }),
    [
      status,
      acting,
      actionError,
      canDisconnect,
      refresh,
      connect,
      pause,
      resume,
      disconnect,
      requestPermission,
    ],
  );
}

/** Keeps the current reading when a new one says the same thing. */
function sameStatus(
  current: ThisComputerStatus | null,
  next: ThisComputerStatus,
): ThisComputerStatus {
  return current && JSON.stringify(current) === JSON.stringify(next) ? current : next;
}
