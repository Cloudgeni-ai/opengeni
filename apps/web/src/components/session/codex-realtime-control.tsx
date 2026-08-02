import {
  projectSessionRealtimeLifecycle,
  type CodexRealtimeController,
  type CodexRealtimeControllerClient,
  type CodexRealtimeControllerSnapshot,
  type EffectiveSessionControl,
  type SessionEvent,
  type SessionStatus,
} from "@opengeni/sdk";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";

const controlButtonClass =
  "inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-md px-3 text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-50";

type AdmissionInput = {
  sessionStatus: SessionStatus;
  controlState: "active" | "paused";
  settlement: { state: string } | null;
  codexConnected: boolean;
  lifecycleActive: boolean;
};

export function codexRealtimeAdmissionAllowed(input: AdmissionInput): boolean {
  return (
    input.sessionStatus !== "cancelled" &&
    input.controlState === "active" &&
    input.settlement === null &&
    input.codexConnected &&
    !input.lifecycleActive
  );
}

export function useSessionCodexRealtime(options: {
  client: CodexRealtimeControllerClient;
  workspaceId: string;
  sessionId: string;
  sessionStatus: SessionStatus;
  effectiveControl: EffectiveSessionControl;
  events: SessionEvent[];
  eventsReady: boolean;
  codexConnected: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const controllerRef = useRef<CodexRealtimeController | null>(null);
  const [snapshot, setSnapshot] = useState<CodexRealtimeControllerSnapshot>(() => ({
    status: hasStoredOwnerProof(options.workspaceId, options.sessionId) ? "recovering" : "idle",
    realtimeId: null,
    mode: null,
    bridge: null,
    microphone: "inactive",
    audibleOutput: "inactive",
    connectionGeneration: 0,
    reconnectAttempt: 0,
    diagnostic: null,
    error: null,
  }));
  const lifecycle = useMemo(
    () => projectSessionRealtimeLifecycle(options.events),
    [options.events],
  );
  const lifecycleRef = useRef(lifecycle);
  const eventsReadyRef = useRef(options.eventsReady);
  lifecycleRef.current = lifecycle;
  eventsReadyRef.current = options.eventsReady;
  const lifecycleActive = lifecycle?.state === "active";

  useEffect(() => {
    let disposed = false;
    let controller: CodexRealtimeController | null = null;
    let unsubscribe: (() => void) | null = null;
    void import("@opengeni/sdk/codex-realtime-controller")
      .then(({ createCodexRealtimeController }) => {
        if (disposed) return;
        controller = createCodexRealtimeController({
          client: options.client,
          workspaceId: options.workspaceId,
          sessionId: options.sessionId,
          ...(audioRef.current ? { remoteAudio: audioRef.current } : {}),
        });
        controllerRef.current = controller;
        unsubscribe = controller.subscribe(setSnapshot);
        if (eventsReadyRef.current) {
          void controller.observeLifecycle(lifecycleRef.current).catch(() => undefined);
        }
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setSnapshot({
          status: "error",
          realtimeId: null,
          mode: null,
          bridge: null,
          microphone: "inactive",
          audibleOutput: "inactive",
          connectionGeneration: 0,
          reconnectAttempt: 0,
          diagnostic: {
            kind: "negotiation_failure",
            message:
              error instanceof Error ? error.message : "Codex realtime controller failed to load",
            recoverable: false,
            connectionGeneration: 0,
            attempt: 0,
          },
          error:
            error instanceof Error ? error.message : "Codex realtime controller failed to load",
        });
      });
    return () => {
      disposed = true;
      unsubscribe?.();
      controller?.close();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [options.client, options.sessionId, options.workspaceId]);

  useEffect(() => {
    if (!options.eventsReady) return;
    void controllerRef.current?.observeLifecycle(lifecycle).catch(() => undefined);
  }, [lifecycle, options.eventsReady]);

  const start = useCallback(async () => {
    await controllerRef.current?.start();
  }, []);
  const stop = useCallback(async () => {
    await controllerRef.current?.stop();
  }, []);
  const retry = useCallback(async () => {
    await controllerRef.current?.retry();
  }, []);
  const retryAudibleOutput = useCallback(async () => {
    await controllerRef.current?.retryAudibleOutput();
  }, []);
  const canStart =
    controllerRef.current !== null &&
    ["idle", "error"].includes(snapshot.status) &&
    codexRealtimeAdmissionAllowed({
      sessionStatus: options.sessionStatus,
      controlState: options.effectiveControl.state,
      settlement: options.effectiveControl.settlement,
      codexConnected: options.codexConnected,
      lifecycleActive,
    });

  return {
    snapshot,
    lifecycleActive,
    canStart,
    codexConnected: options.codexConnected,
    audioRef,
    start,
    stop,
    retry,
    retryAudibleOutput,
  };
}

function hasStoredOwnerProof(workspaceId: string, sessionId: string): boolean {
  if (typeof sessionStorage === "undefined") return false;
  try {
    return (
      sessionStorage.getItem(`opengeni:codex-realtime-owner:${workspaceId}:${sessionId}`) !== null
    );
  } catch {
    return false;
  }
}

export function SessionCodexRealtimeControl(props: {
  client: CodexRealtimeControllerClient;
  workspaceId: string;
  sessionId: string;
  sessionStatus: SessionStatus;
  effectiveControl: EffectiveSessionControl;
  events: SessionEvent[];
  eventsReady: boolean;
  codexConnected: boolean;
}) {
  const realtime = useSessionCodexRealtime(props);

  return (
    <CodexRealtimeControl
      snapshot={realtime.snapshot}
      canStart={realtime.canStart}
      codexConnected={realtime.codexConnected}
      audioRef={realtime.audioRef}
      onStart={realtime.start}
      onStop={realtime.stop}
      onRetry={realtime.retry}
      onRetryAudibleOutput={realtime.retryAudibleOutput}
    />
  );
}

export function CodexRealtimeControl(props: {
  snapshot: CodexRealtimeControllerSnapshot;
  canStart: boolean;
  codexConnected: boolean;
  showDiagnostics?: boolean;
  audioRef: RefObject<HTMLAudioElement | null>;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onRetry: () => Promise<void>;
  onRetryAudibleOutput: () => Promise<void>;
}) {
  const status = statusContent(props.snapshot, props.codexConnected);
  const modeOwned = props.snapshot.mode?.state === "active";
  const showStop = modeOwned && props.snapshot.status !== "lost_owner";
  const showRetry =
    modeOwned &&
    props.snapshot.status !== "stopping" &&
    props.snapshot.status !== "active" &&
    props.snapshot.diagnostic?.recoverable === true;
  const recoveryAction =
    props.snapshot.audibleOutput === "blocked"
      ? { label: "Resume audio", run: props.onRetryAudibleOutput }
      : showRetry
        ? { label: "Retry", run: props.onRetry }
        : null;
  const starting = props.snapshot.status === "starting";

  return (
    <section
      aria-label="Codex realtime"
      className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-4 pb-2 sm:px-6"
    >
      <audio ref={props.audioRef} autoPlay className="hidden" aria-hidden="true" />
      <div className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-2">
        <span
          className={`size-2 shrink-0 rounded-full ${
            props.snapshot.status === "active"
              ? "bg-status-running"
              : status.busy
                ? "animate-pulse bg-brand"
                : "bg-fg-muted"
          }`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p role="status" aria-live="polite" className="truncate text-sm font-medium text-fg">
            {status.label}
          </p>
          <p className="truncate text-xs text-fg-muted">{status.detail}</p>
        </div>
        {showStop ? (
          <>
            {recoveryAction ? (
              <button
                type="button"
                className={`${controlButtonClass} bg-primary text-primary-foreground hover:bg-primary/90`}
                onClick={() => void recoveryAction.run().catch(() => undefined)}
              >
                {recoveryAction.label}
              </button>
            ) : null}
            <button
              type="button"
              className={`${controlButtonClass} bg-secondary text-secondary-foreground hover:bg-secondary/80`}
              aria-label="Stop Codex realtime"
              disabled={props.snapshot.status === "stopping"}
              onClick={() => void props.onStop().catch(() => undefined)}
            >
              {props.snapshot.status === "stopping" ? "Stopping" : "Stop"}
            </button>
          </>
        ) : props.snapshot.status !== "lost_owner" ? (
          <button
            type="button"
            className={`${controlButtonClass} bg-primary text-primary-foreground hover:bg-primary/90`}
            aria-label="Start Codex realtime"
            disabled={!props.canStart || starting}
            onClick={() => void props.onStart().catch(() => undefined)}
          >
            {starting ? "Starting" : "Start"}
          </button>
        ) : null}
      </div>
      {(props.showDiagnostics ?? import.meta.env.DEV) ? (
        <CodexRealtimeDiagnostics snapshot={props.snapshot} />
      ) : null}
      {props.snapshot.error ? (
        <span className="sr-only" role="alert">
          {props.snapshot.error}
        </span>
      ) : null}
    </section>
  );
}

function CodexRealtimeDiagnostics({ snapshot }: { snapshot: CodexRealtimeControllerSnapshot }) {
  const bridge = snapshot.bridge;
  const rows = [
    ["controller", snapshot.status],
    ["microphone", snapshot.microphone],
    ["audio", snapshot.audibleOutput],
    ["generation", String(snapshot.connectionGeneration)],
    ["reconnect attempt", String(snapshot.reconnectAttempt)],
    ["mode", snapshot.mode?.state ?? "none"],
    ["mode version", snapshot.mode ? String(snapshot.mode.version) : "—"],
    ["connection epoch", snapshot.mode ? String(snapshot.mode.connectionEpoch) : "—"],
    ["provider started", bridge ? String(bridge.providerStarted) : "false"],
    ["provider speaking", bridge ? String(bridge.speaking) : "false"],
    ["delegation", bridge?.activeDelegationId ? "active" : "none"],
    ["pending durable events", bridge ? String(bridge.pendingInbound) : "0"],
    ["pending bytes", bridge ? String(bridge.pendingInboundBytes) : "0"],
    ["client ack", bridge?.clientAckThroughSequence?.toString() ?? "—"],
    ["ignored provider events", bridge ? String(bridge.ignoredEventCount) : "0"],
    ["last ignored event", bridge?.lastIgnoredEventType ?? "none"],
    ["bridge error", bridge?.lastError ?? "none"],
    ["diagnostic", snapshot.diagnostic?.kind ?? "none"],
  ] as const;

  return (
    <details className="w-full rounded-md border border-border/70 bg-surface-2/40 px-3 py-2 text-xs text-fg-muted">
      <summary className="cursor-pointer select-none font-medium text-fg">Realtime debug</summary>
      <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1 font-mono">
        {rows.map(([label, value]) => (
          <div className="contents" key={label}>
            <dt>{label}</dt>
            <dd className="min-w-0 truncate text-fg">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 font-sans">
        OpenGeni actions use provider client delegation; direct tool schemas are not exposed by
        realtime V3.
      </p>
    </details>
  );
}

function statusContent(
  snapshot: CodexRealtimeControllerSnapshot,
  codexConnected: boolean,
): { label: string; detail: string; busy: boolean } {
  if (snapshot.audibleOutput === "blocked") {
    return {
      label: "Audio output blocked",
      detail: "Use Resume audio to hear the existing realtime connection",
      busy: false,
    };
  }
  switch (snapshot.status) {
    case "starting":
      return { label: "Starting realtime…", detail: "Connecting microphone and audio", busy: true };
    case "active":
      return { label: "Live", detail: "Codex realtime is active on this session", busy: false };
    case "stopping":
      return { label: "Stopping realtime…", detail: "Returning to normal mode", busy: true };
    case "recovering":
      return {
        label: "Recovering realtime…",
        detail: snapshot.error ?? "Reconnecting the same browser-owned mode",
        busy: true,
      };
    case "lost_owner":
      return {
        label: "Realtime active in another browser",
        detail: "Wait for that owner to stop or its lease to expire",
        busy: false,
      };
    case "error":
      return {
        label: "Realtime unavailable",
        detail: snapshot.error ?? "Start failed",
        busy: false,
      };
    case "idle":
      return codexConnected
        ? { label: "Ready for realtime", detail: "Talk with Codex on this session", busy: false }
        : {
            label: "Codex connection required",
            detail: "Connect Codex to use realtime",
            busy: false,
          };
  }
}
