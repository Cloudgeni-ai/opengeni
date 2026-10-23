import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  thisComputerPermissionSteps,
  type ThisComputerHost,
  type ThisComputerPermissionId,
  type ThisComputerStatus,
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
  /** Computer use is being turned on ("on") or off ("off") from these screens. */
  pending: "on" | "off" | null;
  /**
   * While turning on: the permission the system is being asked for (its
   * prompt, or its System Settings list with the app's guide). Null once it
   * is granted with nothing else missing, or the person came back without
   * allowing it.
   */
  asking: ThisComputerPermissionId | null;
  refresh(): void;
  connect(options: { screenControl: boolean }): Promise<ThisComputerStatus | null>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Turns computer use on, doing whatever it takes: resumes a paused agent,
   * registers this computer (again) when it never was or its registration is
   * gone (e.g. removed from Machines), and starts the agent. Then it asks for
   * each missing permission in turn (see `asking`), so turning on is one step.
   * Resolves with the status before any permission is asked for.
   */
  turnOn(): Promise<ThisComputerStatus | null>;
  /**
   * Asks for the missing permissions, one after another as each is granted,
   * until the person comes back without allowing one. Nothing when none is missing.
   * Pass a reading just returned by an action, as the hook's may not have caught up.
   */
  allowPermissions(status?: ThisComputerStatus | null): void;
  /** Turns computer use off: pauses the agent, keeping its registration so on is instant. */
  turnOff(): Promise<void>;
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
  options: {
    pollMs?: number;
    /** How long asking waits in the app with no system window shown before it stops. */
    askQuietMs?: number;
  } = {},
): UseThisComputerResult {
  const [status, setStatus] = useState<ThisComputerStatus | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<"on" | "off" | null>(null);
  const [asking, setAsking] = useState<ThisComputerPermissionId | null>(null);
  /** What is being asked for and since when; whether the person came back since. */
  const askingRef = useRef<{
    id: ThisComputerPermissionId;
    at: number;
    returned: boolean;
    timers: number[];
  } | null>(null);
  const askQuietMs = options.askQuietMs ?? ASK_QUIET_MS;
  const live = useRef(true);
  const stopAsking = useCallback(() => {
    for (const timer of askingRef.current?.timers ?? []) window.clearTimeout(timer);
    askingRef.current = null;
    setAsking(null);
  }, []);
  const statusRef = useRef(status);
  statusRef.current = status;
  /** Set below: continues or ends the asking after each reading. */
  const askNextRef = useRef<(next: ThisComputerStatus) => void>(() => undefined);
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
        if (!live.current || mine.generation !== generation.current) return;
        setStatus((current) => sameStatus(current, next));
        askNextRef.current(next);
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
    stopAsking();
    refresh();
    if (!host) return;
    const unsubscribe = host.onChange(refresh);
    const onFocus = () => {
      // Back in the app while a permission is asked for: if the next reading
      // still lacks it, the person didn't allow it, and asking stops there.
      const current = askingRef.current;
      if (current && Date.now() - current.at > RETURN_GRACE_MS) current.returned = true;
      refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      live.current = false;
      stopAsking();
      unsubscribe();
      window.removeEventListener("focus", onFocus);
    };
  }, [host, refresh, stopAsking]);

  // A service outlives this desktop process; its state changes without the
  // hosted-child notifications (including pause/resume from another client).
  const pollMs =
    options.pollMs ??
    (status?.management === "service" && status.state !== "not_connected" ? 5_000 : undefined);
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

  const ask = useCallback(
    (id: ThisComputerPermissionId) => {
      if (!host?.requestPermission) return;
      for (const timer of askingRef.current?.timers ?? []) window.clearTimeout(timer);
      const entry = { id, at: Date.now(), returned: false, timers: [] as number[] };
      askingRef.current = entry;
      setAsking(id);
      const mine = generation.current;
      // Asking ends when the person is back in the app without allowing it.
      // The window's focus says so when the system took it away; when no
      // system window appeared at all (macOS already decided, or answered at
      // once), the app still has focus a moment later.
      const stillHere = () => {
        if (askingRef.current !== entry || !live.current) return;
        if (typeof document.hasFocus !== "function" || document.hasFocus()) {
          entry.returned = true;
          refreshRef.current();
        } else entry.timers.push(window.setTimeout(stillHere, askQuietMs));
      };
      entry.timers.push(
        window.setTimeout(() => {
          if (askingRef.current !== entry || !live.current) return;
          entry.returned = true;
          refreshRef.current();
        }, ASK_LIMIT_MS),
      );
      void host
        .requestPermission(id)
        .catch(() => undefined)
        .finally(() => {
          if (!live.current || mine !== generation.current) return;
          refreshRef.current();
          if (askingRef.current === entry)
            entry.timers.push(window.setTimeout(stillHere, askQuietMs));
        });
    },
    [askQuietMs, host],
  );
  /** After each reading while asking: ask for the next missing permission, or stop. */
  const askNext = useCallback(
    (next: ThisComputerStatus) => {
      const current = askingRef.current;
      if (!current) return;
      const missing = missingStep(next);
      // The one asked for was allowed and another is missing: ask for that one.
      if (missing !== null && missing !== current.id) return ask(missing);
      // All allowed, turned off meanwhile, or the person came back without allowing it.
      if (missing === null || current.returned) stopAsking();
    },
    [ask, stopAsking],
  );
  askNextRef.current = askNext;
  const allowPermissions = useCallback(
    (next?: ThisComputerStatus | null) => {
      const missing = missingStep(next ?? statusRef.current);
      if (missing !== null) ask(missing);
    },
    [ask],
  );

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
    if (!host) return;
    const next = await act(async () => {
      await host.resume();
      return await host.status(workspaceId).catch(() => null);
    });
    if (next && live.current) setStatus((current) => sameStatus(current, next));
  }, [act, host, workspaceId]);
  const disconnect = useCallback(async () => {
    if (host?.disconnect) await act(() => host.disconnect!(workspaceId));
  }, [act, host, workspaceId]);
  const turnOn = useCallback(async () => {
    if (!host || actionInFlight.current) return null;
    setPending("on");
    try {
      const next = await act(async () => {
        let current = await host.status(workspaceId);
        // Off is paused, and a connection that failed is started again.
        if (current.state === "paused" || (current.state === "connected" && current.error)) {
          await host.resume();
          current = await host.status(workspaceId);
        }
        if (current.state !== "not_connected" && current.state !== "not_installed") return current;
        // Never set up, or its registration is gone: register this computer afresh.
        return await host.connect(workspaceId, { screenControl: true });
      });
      if (next && live.current) {
        setStatus((current) => sameStatus(current, next));
        // One step: the missing permissions are asked for right away.
        const missing = missingStep(next);
        if (missing !== null) ask(missing);
      }
      return next;
    } finally {
      if (live.current) setPending(null);
    }
  }, [act, ask, host, workspaceId]);
  const turnOff = useCallback(async () => {
    if (!host || actionInFlight.current) return;
    stopAsking();
    setPending("off");
    try {
      // Off shows until the reading after pausing is in, never On in between.
      const next = await act(async () => {
        await host.pause();
        return await host.status(workspaceId).catch(() => null);
      });
      if (next && live.current) setStatus((current) => sameStatus(current, next));
    } finally {
      if (live.current) setPending(null);
    }
  }, [act, host, stopAsking, workspaceId]);
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
      pending,
      asking,
      refresh,
      connect,
      pause,
      resume,
      disconnect,
      turnOn,
      turnOff,
      allowPermissions,
      requestPermission,
    }),
    [
      status,
      acting,
      actionError,
      canDisconnect,
      pending,
      asking,
      refresh,
      connect,
      pause,
      resume,
      disconnect,
      turnOn,
      turnOff,
      allowPermissions,
      requestPermission,
    ],
  );
}

/** A focus this soon after asking is the system's own prompt closing, not the person coming back. */
const RETURN_GRACE_MS = 1_500;
/** Asking for a permission with the app still in front this long: no system window came up. */
const ASK_QUIET_MS = 4_000;
/** Asking stops after this long regardless (the host stops watching for grants then too). */
const ASK_LIMIT_MS = 10 * 60_000;

/** The first permission step still missing on a connected computer, or null. */
function missingStep(status: ThisComputerStatus | null): ThisComputerPermissionId | null {
  if (status?.state !== "connected") return null;
  return thisComputerPermissionSteps(status).find((step) => !step.granted)?.id ?? null;
}

/** Keeps the current reading when a new one says the same thing. */
function sameStatus(
  current: ThisComputerStatus | null,
  next: ThisComputerStatus,
): ThisComputerStatus {
  return current && JSON.stringify(current) === JSON.stringify(next) ? current : next;
}
