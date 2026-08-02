import {
  projectSessionRealtimeLifecycle,
  type CodexRealtimeController,
  type CodexRealtimeControllerClient,
  type CodexRealtimeControllerSnapshot,
  type EffectiveSessionControl,
  type SessionEvent,
  type SessionStatus,
} from "@opengeni/sdk";
import {
  AudioLinesIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  SquareIcon,
  Volume2Icon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type RealtimeModelOption = {
  id: string;
  label: string;
  provider: string;
  description: string;
  recommended?: boolean | undefined;
};

const CODEX_LIVE_MODEL: RealtimeModelOption = {
  id: "gpt-live-1-boulder-alpha",
  label: "Codex Live",
  provider: "Connected Codex",
  description: "Deep session integration",
  recommended: true,
};

const SUPPORTED_REALTIME_MODELS = [CODEX_LIVE_MODEL] as const;

type AdmissionInput = {
  sessionStatus: SessionStatus;
  controlState: "active" | "paused";
  settlement: { state: string } | null;
  codexConnected: boolean;
  lifecycleActive: boolean;
};

export function codexRealtimeAdmissionAllowed(input: AdmissionInput): boolean {
  return codexRealtimeAdmissionBlocker(input) === null;
}

export function codexRealtimeAdmissionBlocker(input: AdmissionInput): string | null {
  if (input.sessionStatus === "cancelled") return "This session was cancelled.";
  if (input.controlState !== "active") return "Resume this session before starting voice.";
  if (input.settlement !== null) return "Wait for the current session transition to finish.";
  if (!input.codexConnected) return "Connect Codex to use this voice model.";
  if (input.lifecycleActive) return "Voice is already active for this session.";
  return null;
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
  const admissionInput = {
    sessionStatus: options.sessionStatus,
    controlState: options.effectiveControl.state,
    settlement: options.effectiveControl.settlement,
    codexConnected: options.codexConnected,
    lifecycleActive,
  } satisfies AdmissionInput;
  const admissionBlocker = codexRealtimeAdmissionBlocker(admissionInput);
  const canStart =
    controllerRef.current !== null &&
    ["idle", "error"].includes(snapshot.status) &&
    admissionBlocker === null;

  return {
    snapshot,
    lifecycleActive,
    canStart,
    admissionBlocker,
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
  underlyingModel: string;
}) {
  const realtime = useSessionCodexRealtime(props);

  return (
    <CodexRealtimeControl
      snapshot={realtime.snapshot}
      canStart={realtime.canStart}
      admissionBlocker={realtime.admissionBlocker}
      codexConnected={realtime.codexConnected}
      audioRef={realtime.audioRef}
      underlyingModel={props.underlyingModel}
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
  admissionBlocker?: string | null | undefined;
  codexConnected: boolean;
  showDiagnostics?: boolean;
  audioRef: RefObject<HTMLAudioElement | null>;
  underlyingModel?: string | undefined;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onRetry: () => Promise<void>;
  onRetryAudibleOutput: () => Promise<void>;
}) {
  const reduceMotion = useReducedMotion();
  const selectedModel = CODEX_LIVE_MODEL;
  const status = statusContent(
    props.snapshot,
    props.codexConnected,
    props.canStart,
    props.admissionBlocker ?? null,
    selectedModel.label,
  );
  const modeOwned = props.snapshot.mode?.state === "active";
  const retryConnection =
    modeOwned &&
    props.snapshot.status !== "stopping" &&
    props.snapshot.status !== "active" &&
    props.snapshot.diagnostic?.recoverable === true;
  const audioBlocked = props.snapshot.audibleOutput === "blocked";
  const mainDisabled =
    props.snapshot.status === "stopping" ||
    props.snapshot.status === "lost_owner" ||
    (!modeOwned && !props.canStart) ||
    (props.snapshot.status === "starting" && !modeOwned);
  const mainLabel = audioBlocked
    ? "Resume voice audio"
    : retryConnection
      ? "Retry voice connection"
      : modeOwned
        ? "End voice conversation"
        : `Start voice with ${selectedModel.label}`;
  const runMainAction = audioBlocked
    ? props.onRetryAudibleOutput
    : retryConnection
      ? props.onRetry
      : modeOwned
        ? props.onStop
        : props.onStart;
  const diagnosticsVisible = props.showDiagnostics ?? import.meta.env.DEV;

  return (
    <div aria-label="Realtime voice" className="inline-flex shrink-0 items-center">
      <audio ref={props.audioRef} autoPlay className="hidden" aria-hidden="true" />
      <RealtimeComposerGlow phase={status.phase} reduceMotion={reduceMotion === true} />
      <motion.button
        type="button"
        data-testid="realtime-primary-action"
        data-phase={status.phase}
        aria-label={mainLabel}
        aria-pressed={modeOwned}
        title={mainLabel}
        disabled={mainDisabled}
        whileTap={reduceMotion ? undefined : { scale: 0.92 }}
        transition={{ type: "spring", stiffness: 520, damping: 30 }}
        onClick={() => void runMainAction().catch(() => undefined)}
        className={cn(
          "relative inline-flex size-8 items-center justify-center rounded-l-og-md border outline-none",
          "transition-[background-color,border-color,color,box-shadow] duration-200 ease-og-out",
          "focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-og-accent/45",
          "disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:size-11",
          voiceButtonTone(status.phase),
        )}
      >
        <RealtimeActionGlyph
          phase={status.phase}
          audioBlocked={audioBlocked}
          reduceMotion={reduceMotion === true}
        />
      </motion.button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Choose voice model and options"
            title={`Voice model: ${selectedModel.label}`}
            className={cn(
              "inline-flex h-8 w-5 items-center justify-center rounded-r-og-md border border-l-0 outline-none",
              "transition-[background-color,border-color,color] duration-200 ease-og-out",
              "focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-og-accent/45",
              "pointer-coarse:h-11 pointer-coarse:w-7",
              voiceButtonTone(status.phase),
            )}
          >
            <ChevronDownIcon className="size-3" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="end"
          sideOffset={10}
          collisionPadding={16}
          className="w-[min(22rem,calc(100vw-2rem))] rounded-og-lg border-og-border bg-og-surface-1 p-1.5 text-og-fg shadow-og-lg"
        >
          <DropdownMenuLabel className="px-2.5 pb-1 pt-2 text-og-xs font-semibold uppercase tracking-[0.12em] text-og-fg-subtle">
            Voice model
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup value={selectedModel.id}>
            {SUPPORTED_REALTIME_MODELS.map((model) => (
              <DropdownMenuRadioItem
                key={model.id}
                value={model.id}
                className="items-start rounded-og-md py-2.5 pl-8 pr-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-og-sm font-medium text-og-fg">
                      {model.label}
                    </span>
                    {model.recommended ? (
                      <span className="rounded-full border border-og-accent/25 bg-og-accent-soft px-1.5 py-0.5 text-[10px] font-medium leading-none text-og-accent">
                        Recommended
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-og-xs text-og-fg-subtle">
                    {model.provider} · {model.description}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>

          <DropdownMenuSeparator className="mx-1 bg-og-border" />
          <div className="px-2.5 py-2" role="status" aria-live="polite">
            <div className="flex items-center gap-2 text-og-sm font-medium text-og-fg">
              <RealtimeStatusDot phase={status.phase} reduceMotion={reduceMotion === true} />
              {status.label}
            </div>
            <p className="mt-1 text-og-xs leading-5 text-og-fg-subtle">{status.detail}</p>
          </div>

          <div className="mx-2 mb-1 rounded-og-md border border-og-border/70 bg-og-surface-2/60 px-2.5 py-2">
            <p className="truncate text-og-xs font-medium text-og-fg">
              Session agent: {friendlyModelName(props.underlyingModel)}
            </p>
            <p className="mt-0.5 text-[11px] leading-4 text-og-fg-subtle">
              Voice handles conversation; your session agent handles durable work.
            </p>
          </div>

          {audioBlocked ? (
            <DropdownMenuItem
              className="rounded-og-md"
              onSelect={() => void props.onRetryAudibleOutput().catch(() => undefined)}
            >
              <Volume2Icon />
              Resume audio
            </DropdownMenuItem>
          ) : null}
          {retryConnection ? (
            <DropdownMenuItem
              className="rounded-og-md"
              onSelect={() => void props.onRetry().catch(() => undefined)}
            >
              <RotateCcwIcon />
              Retry connection
            </DropdownMenuItem>
          ) : null}
          {modeOwned && props.snapshot.status !== "lost_owner" ? (
            <DropdownMenuItem
              variant="destructive"
              className="rounded-og-md"
              disabled={props.snapshot.status === "stopping"}
              onSelect={() => void props.onStop().catch(() => undefined)}
            >
              <SquareIcon />
              End voice conversation
            </DropdownMenuItem>
          ) : null}

          {diagnosticsVisible ? <RealtimeDiagnosticsMenu snapshot={props.snapshot} /> : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="sr-only" role="status" aria-live="polite">
        {status.label}. {status.detail}
      </span>
      {props.snapshot.error ? (
        <span className="sr-only" role="alert">
          {props.snapshot.error}
        </span>
      ) : null}
    </div>
  );
}

function RealtimeDiagnosticsMenu({ snapshot }: { snapshot: CodexRealtimeControllerSnapshot }) {
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
    <>
      <DropdownMenuSeparator className="mx-1 bg-og-border" />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="rounded-og-md text-og-fg-muted">
          Realtime diagnostics
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-80 w-72 overflow-y-auto rounded-og-lg border-og-border bg-og-surface-1 p-1.5 text-og-fg shadow-og-lg">
          {rows.map(([label, value]) => (
            <DropdownMenuItem
              key={label}
              disabled
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 rounded-og-md font-mono text-[11px] opacity-100"
            >
              <span className="truncate text-og-fg-subtle">{label}</span>
              <span className="truncate text-right text-og-fg">{value}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

type RealtimeVisualPhase =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "reconnecting"
  | "blocked"
  | "unavailable"
  | "error"
  | "elsewhere"
  | "stopping";

function statusContent(
  snapshot: CodexRealtimeControllerSnapshot,
  codexConnected: boolean,
  canStart: boolean,
  admissionBlocker: string | null,
  modelLabel: string,
): { phase: RealtimeVisualPhase; label: string; detail: string } {
  if (snapshot.audibleOutput === "blocked") {
    return {
      phase: "blocked",
      label: "Audio output blocked",
      detail: "Resume audio to hear the existing voice connection.",
    };
  }
  switch (snapshot.status) {
    case "starting":
      return {
        phase: "connecting",
        label: "Connecting…",
        detail: "Preparing your microphone and live voice.",
      };
    case "active":
      return snapshot.bridge?.speaking
        ? {
            phase: "speaking",
            label: "Speaking",
            detail: "Interrupt naturally whenever you want.",
          }
        : {
            phase: "listening",
            label: "Listening",
            detail: "Voice and typed messages share this session.",
          };
    case "stopping":
      return {
        phase: "stopping",
        label: "Ending voice…",
        detail: "Saving the remaining conversation context.",
      };
    case "recovering":
      return {
        phase: "reconnecting",
        label: "Reconnecting…",
        detail: snapshot.error ?? "Keeping this voice conversation connected.",
      };
    case "lost_owner":
      return {
        phase: "elsewhere",
        label: "Voice active elsewhere",
        detail: "Return to the browser that started it, or wait for that connection to expire.",
      };
    case "error":
      return {
        phase: "error",
        label: "Voice unavailable",
        detail: snapshot.error ?? "The connection could not be started.",
      };
    case "idle":
      if (!codexConnected) {
        return {
          phase: "unavailable",
          label: "Connect Codex for voice",
          detail: "Connect a Codex account before using this voice model.",
        };
      }
      if (!canStart && admissionBlocker) {
        return { phase: "unavailable", label: "Voice unavailable", detail: admissionBlocker };
      }
      return {
        phase: "idle",
        label: "Start voice",
        detail: `Talk live with ${modelLabel}.`,
      };
  }
}

function RealtimeComposerGlow(props: { phase: RealtimeVisualPhase; reduceMotion: boolean }) {
  const visible = [
    "connecting",
    "listening",
    "speaking",
    "reconnecting",
    "blocked",
    "error",
    "stopping",
  ].includes(props.phase);
  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.span
          aria-hidden
          key={props.phase}
          initial={{ opacity: 0 }}
          animate={
            props.reduceMotion
              ? { opacity: 0.48 }
              : props.phase === "speaking"
                ? { opacity: [0.42, 0.82, 0.52] }
                : props.phase === "listening"
                  ? { opacity: [0.34, 0.62, 0.42] }
                  : { opacity: [0.28, 0.58, 0.28] }
          }
          exit={{ opacity: 0 }}
          transition={
            props.reduceMotion
              ? { duration: 0.12 }
              : {
                  duration: props.phase === "speaking" ? 1.15 : 2.1,
                  ease: "easeInOut",
                  repeat: Number.POSITIVE_INFINITY,
                }
          }
          className={cn(
            "pointer-events-none absolute -inset-px z-[1] rounded-og-lg ring-1 ring-inset shadow-og-glow",
            props.phase === "speaking"
              ? "ring-og-status-running/50"
              : props.phase === "blocked" || props.phase === "error"
                ? "ring-og-status-waiting/45"
                : "ring-og-accent/45",
          )}
        />
      ) : null}
    </AnimatePresence>
  );
}

function RealtimeActionGlyph(props: {
  phase: RealtimeVisualPhase;
  audioBlocked: boolean;
  reduceMotion: boolean;
}) {
  if (["connecting", "reconnecting", "stopping"].includes(props.phase)) {
    return <LoaderCircleIcon className="size-3.5 animate-og-spin" aria-hidden />;
  }
  if (props.phase === "blocked") {
    return props.audioBlocked ? (
      <Volume2Icon className="size-3.5" aria-hidden />
    ) : (
      <CircleAlertIcon className="size-3.5" aria-hidden />
    );
  }
  if (props.phase === "error" || props.phase === "elsewhere" || props.phase === "unavailable") {
    return <CircleAlertIcon className="size-3.5" aria-hidden />;
  }
  if (props.phase === "listening" || props.phase === "speaking") {
    return (
      <span className="relative inline-flex size-4 items-center justify-center">
        {!props.reduceMotion ? (
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-full border border-current"
            animate={{ opacity: [0.65, 0], scale: [0.65, 1.45] }}
            transition={{
              duration: props.phase === "speaking" ? 0.9 : 1.5,
              ease: "easeOut",
              repeat: Number.POSITIVE_INFINITY,
            }}
          />
        ) : null}
        <SquareIcon className="relative size-2.5 fill-current" aria-hidden />
      </span>
    );
  }
  return <AudioLinesIcon className="size-4" aria-hidden />;
}

function RealtimeStatusDot(props: { phase: RealtimeVisualPhase; reduceMotion: boolean }) {
  const live = props.phase === "listening" || props.phase === "speaking";
  return (
    <span className="relative inline-flex size-2 shrink-0" aria-hidden>
      {live && !props.reduceMotion ? (
        <motion.span
          className="absolute inset-0 rounded-full bg-og-status-running"
          animate={{ opacity: [0.45, 0], scale: [1, 2.2] }}
          transition={{ duration: 1.4, ease: "easeOut", repeat: Number.POSITIVE_INFINITY }}
        />
      ) : null}
      <span
        className={cn(
          "relative size-2 rounded-full",
          live
            ? "bg-og-status-running"
            : props.phase === "blocked" || props.phase === "error"
              ? "bg-og-status-waiting"
              : props.phase === "elsewhere" || props.phase === "unavailable"
                ? "bg-og-fg-subtle"
                : "bg-og-accent",
        )}
      />
    </span>
  );
}

function voiceButtonTone(phase: RealtimeVisualPhase): string {
  if (phase === "listening" || phase === "speaking") {
    return "border-og-accent/45 bg-og-accent text-og-accent-fg shadow-og-sm hover:bg-og-accent-strong";
  }
  if (phase === "blocked" || phase === "error") {
    return "border-og-status-waiting/35 bg-og-status-waiting/10 text-og-status-waiting hover:bg-og-status-waiting/15";
  }
  if (phase === "connecting" || phase === "reconnecting" || phase === "stopping") {
    return "border-og-accent/35 bg-og-accent-soft text-og-accent";
  }
  return "border-og-border bg-og-surface-2 text-og-fg-muted hover:border-og-accent/35 hover:bg-og-accent-soft hover:text-og-accent";
}

function friendlyModelName(model: string | undefined): string {
  if (!model) return "Current session model";
  const providerSeparator = model.lastIndexOf("/");
  return providerSeparator >= 0 ? model.slice(providerSeparator + 1) : model;
}
