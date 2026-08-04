import { type EffectiveSessionControl, type SessionEvent, type SessionStatus } from "@opengeni/sdk";
import {
  hasStoredSessionRealtimeOwnerProof,
  projectSessionRealtimeLifecycle,
  type SessionRealtimeClientLike,
  type SessionRealtimeController,
  type SessionRealtimeControllerSnapshot,
  type CreateSessionRealtimeControllerOptions,
  type SessionRealtimeModel,
  type WorkspaceRealtimeModelCatalogItem,
} from "@opengeni/sdk/realtime";
import {
  AudioLinesIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  MicIcon,
  MicOffIcon,
  RotateCcwIcon,
  SquareIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  BillingClassMark,
  PickerAnimatedPage,
  PickerBackHeader,
  PickerNavRow,
} from "../components/model-policy-picker";
import type { EmbeddedRealtimeSessionClientLike } from "../client";
import { cn } from "../lib/cn";
import type { PickerBillingClass as BillingClass } from "../model-policy";
import { useEmbeddedRealtimeSession } from "../session-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

export type RealtimeModelOption = {
  id: SessionRealtimeModel;
  label: string;
  provider: "OpenGeni" | "Connected Codex" | "Your Gateway";
  description: string;
  available: boolean;
  unavailableReason: string | null;
  recommended: boolean;
};

const CODEX_LIVE_MODEL: RealtimeModelOption = {
  id: "gpt-live-1-boulder-alpha",
  label: "Codex Live",
  provider: "Connected Codex",
  description: "Deep session integration",
  available: false,
  unavailableReason: "Connect Codex to use this voice model",
  recommended: false,
};

const REALTIME_MODEL_PROVIDERS = ["OpenGeni", "Connected Codex", "Your Gateway"] as const;
type RealtimeModelProvider = (typeof REALTIME_MODEL_PROVIDERS)[number];

const REALTIME_PROVIDER_META: Record<
  RealtimeModelProvider,
  { billingClass: BillingClass; hint: string }
> = {
  OpenGeni: { billingClass: "opengeni_credits", hint: "Will use credits" },
  "Connected Codex": {
    billingClass: "codex_subscription",
    hint: "ChatGPT / Codex plan",
  },
  "Your Gateway": { billingClass: "byok", hint: "Billed to your AI Gateway" },
};
const REALTIME_MODEL_STORAGE_PREFIX = "opengeni:realtime-model";

type RealtimeControllerClient = EmbeddedRealtimeSessionClientLike & SessionRealtimeClientLike;

export type SessionRealtimeControllerFactory = (
  options: CreateSessionRealtimeControllerOptions,
) => SessionRealtimeController;

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

export function useSessionRealtime(options: {
  client?: RealtimeControllerClient | undefined;
  workspaceId?: string | undefined;
  sessionId: string;
  sessionStatus: SessionStatus;
  effectiveControl: EffectiveSessionControl;
  events: SessionEvent[];
  eventsReady: boolean;
  codexConnected: boolean;
  model?: SessionRealtimeModel | undefined;
  modelAvailable?: boolean | undefined;
  modelUnavailableReason?: string | null | undefined;
  /** Deterministic browser-test/demo seam. Production hosts should use the SDK default. */
  controllerFactory?: SessionRealtimeControllerFactory | undefined;
}) {
  const { client, workspaceId } = useEmbeddedRealtimeSession({
    client: options.client,
    workspaceId: options.workspaceId,
  });
  const model = options.model ?? CODEX_LIVE_MODEL.id;
  const audioRef = useRef<HTMLAudioElement>(null);
  const controllerRef = useRef<SessionRealtimeController | null>(null);
  const controllerModelRef = useRef<SessionRealtimeModel | null>(null);
  const [snapshot, setSnapshot] = useState<SessionRealtimeControllerSnapshot>(() => ({
    status: hasStoredSessionRealtimeOwnerProof({ workspaceId, sessionId: options.sessionId, model })
      ? "recovering"
      : "idle",
    realtimeId: null,
    mode: null,
    bridge: null,
    microphone: "inactive",
    inputMuted: false,
    audibleOutput: "inactive",
    outputMuted: false,
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
    let controller: SessionRealtimeController | null = null;
    let unsubscribe: (() => void) | null = null;
    void import("@opengeni/sdk/realtime")
      .then(({ createSessionRealtimeController }) => {
        if (disposed) return;
        const controllerFactory = options.controllerFactory ?? createSessionRealtimeController;
        controller = controllerFactory({
          client,
          workspaceId,
          sessionId: options.sessionId,
          ...(audioRef.current ? { remoteAudio: audioRef.current } : {}),
          model,
        });
        controllerRef.current = controller;
        controllerModelRef.current = model;
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
          inputMuted: false,
          audibleOutput: "inactive",
          outputMuted: false,
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
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        controllerModelRef.current = null;
      }
    };
  }, [client, model, options.controllerFactory, options.sessionId, workspaceId]);

  useEffect(() => {
    if (!options.eventsReady) return;
    void controllerRef.current?.observeLifecycle(lifecycle).catch(() => undefined);
  }, [lifecycle, options.eventsReady]);

  const start = useCallback(async () => {
    const controller = controllerRef.current;
    if (!controller || controllerModelRef.current !== model) {
      throw new Error("The selected voice model is still preparing");
    }
    await controller.start();
  }, [model]);
  const stop = useCallback(async () => {
    await controllerRef.current?.stop();
  }, []);
  const retry = useCallback(async () => {
    await controllerRef.current?.retry();
  }, []);
  const retryAudibleOutput = useCallback(async () => {
    await controllerRef.current?.retryAudibleOutput();
  }, []);
  const setInputMuted = useCallback((muted: boolean) => {
    controllerRef.current?.setInputMuted(muted);
  }, []);
  const setOutputMuted = useCallback((muted: boolean) => {
    controllerRef.current?.setOutputMuted(muted);
  }, []);
  const admissionInput = {
    sessionStatus: options.sessionStatus,
    controlState: options.effectiveControl.state,
    settlement: options.effectiveControl.settlement,
    codexConnected: options.modelAvailable ?? options.codexConnected,
    lifecycleActive,
  } satisfies AdmissionInput;
  const admissionBlocker =
    options.modelAvailable === false
      ? (options.modelUnavailableReason ?? "This voice model is unavailable.")
      : codexRealtimeAdmissionBlocker(admissionInput);
  const canStart =
    controllerRef.current !== null &&
    controllerModelRef.current === model &&
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
    setInputMuted,
    setOutputMuted,
  };
}

export function SessionRealtimeControl(props: {
  client?: RealtimeControllerClient | undefined;
  workspaceId?: string | undefined;
  sessionId: string;
  sessionStatus: SessionStatus;
  effectiveControl: EffectiveSessionControl;
  events: SessionEvent[];
  eventsReady: boolean;
  codexConnected: boolean;
  realtimeAutostartModel?: SessionRealtimeModel | undefined;
  onRealtimeAutostartConsumed?: (() => void) | undefined;
  /** Host hides dictate (and can choreograph layout) while realtime voice is live. */
  onVoiceActiveChange?: ((active: boolean) => void) | undefined;
  /** Deterministic browser-test/demo seam. Production hosts should use the SDK default. */
  controllerFactory?: SessionRealtimeControllerFactory | undefined;
}) {
  const lifecycle = useMemo(() => projectSessionRealtimeLifecycle(props.events), [props.events]);
  const selection = useRealtimeModelSelection({
    client: props.client,
    workspaceId: props.workspaceId,
    codexConnected: props.codexConnected,
    activeModel: lifecycle?.state === "active" ? lifecycle.model : null,
  });
  const selectedModel = selection.selectedModel;
  const realtime = useSessionRealtime({
    ...props,
    model: selectedModel.id,
    modelAvailable: selectedModel.available,
    modelUnavailableReason: selectedModel.unavailableReason,
  });
  const autostartModelRef = useRef(props.realtimeAutostartModel ?? null);
  const autostartStartedRef = useRef(false);

  const { models, selectedModel: selectedRealtimeModel, selectModel } = selection;
  const { canStart, start } = realtime;
  const onRealtimeAutostartConsumed = props.onRealtimeAutostartConsumed;
  const onVoiceActiveChange = props.onVoiceActiveChange;
  const voiceActive = realtime.snapshot.mode?.state === "active";

  useEffect(() => {
    onVoiceActiveChange?.(voiceActive);
  }, [onVoiceActiveChange, voiceActive]);

  useEffect(() => {
    const pending = autostartModelRef.current;
    if (!pending || autostartStartedRef.current || lifecycle?.state === "active") return;
    const available = models.some((model) => model.id === pending && model.available);
    if (!available) return;
    if (selectedRealtimeModel.id !== pending) {
      selectModel(pending);
      return;
    }
    if (!canStart) return;
    autostartStartedRef.current = true;
    void start()
      .then(() => {
        autostartModelRef.current = null;
        onRealtimeAutostartConsumed?.();
      })
      .catch(() => {
        autostartStartedRef.current = false;
      });
  }, [
    canStart,
    lifecycle?.state,
    models,
    props.sessionId,
    props.workspaceId,
    onRealtimeAutostartConsumed,
    selectModel,
    selectedRealtimeModel.id,
    start,
  ]);

  return (
    <RealtimeVoiceControl
      snapshot={realtime.snapshot}
      canStart={realtime.canStart}
      admissionBlocker={realtime.admissionBlocker}
      modelAvailable={selectedModel.available}
      menuSide="top"
      audioRef={realtime.audioRef}
      selectedModel={selectedModel}
      models={selection.models}
      onSelectModel={realtime.lifecycleActive ? undefined : selection.selectModel}
      onStart={realtime.start}
      onStop={realtime.stop}
      onRetry={realtime.retry}
      onRetryAudibleOutput={realtime.retryAudibleOutput}
      onSetInputMuted={realtime.setInputMuted}
      onSetOutputMuted={realtime.setOutputMuted}
    />
  );
}

export function useRealtimeModelSelection(options: {
  client?: RealtimeControllerClient | undefined;
  workspaceId?: string | undefined;
  codexConnected: boolean;
  activeModel?: SessionRealtimeModel | null | undefined;
}) {
  const { client, workspaceId } = useEmbeddedRealtimeSession({
    client: options.client,
    workspaceId: options.workspaceId,
  });
  const activeModel = options.activeModel;
  const [catalog, setCatalog] = useState<RealtimeModelOption[]>(() => [
    {
      ...CODEX_LIVE_MODEL,
      available: options.codexConnected,
      unavailableReason: options.codexConnected ? null : CODEX_LIVE_MODEL.unavailableReason,
    },
  ]);
  const [selectedModelId, setSelectedModelId] = useState<SessionRealtimeModel>(
    () => readRealtimeModelPreference(workspaceId) ?? CODEX_LIVE_MODEL.id,
  );

  useEffect(() => {
    let disposed = false;
    const load = client.getWorkspaceRealtimeModelCatalog;
    if (!load) return;
    void load
      .call(client, workspaceId)
      .then((response) => {
        if (disposed) return;
        const models = response.models.map(toRealtimeModelOption);
        setCatalog(models);
        setSelectedModelId((current) => {
          if (models.some((model) => model.id === current && model.available)) return current;
          return models.find((model) => model.available)?.id ?? CODEX_LIVE_MODEL.id;
        });
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [client, workspaceId]);

  useEffect(() => {
    if (activeModel) setSelectedModelId(activeModel);
  }, [activeModel]);

  const selectedModel =
    catalog.find((model) => model.id === selectedModelId) ??
    ({
      ...CODEX_LIVE_MODEL,
      available: options.codexConnected,
      unavailableReason: options.codexConnected ? null : CODEX_LIVE_MODEL.unavailableReason,
    } satisfies RealtimeModelOption);
  const selectModel = useCallback(
    (value: string) => {
      const model = catalog.find((candidate) => candidate.id === value);
      if (!model || !model.available || activeModel) return;
      setSelectedModelId(model.id);
      writeRealtimeModelPreference(workspaceId, model.id);
    },
    [activeModel, catalog, workspaceId],
  );

  return { models: catalog, selectedModel, selectModel };
}

const IDLE_REALTIME_SNAPSHOT: SessionRealtimeControllerSnapshot = {
  status: "idle",
  realtimeId: null,
  mode: null,
  bridge: null,
  microphone: "inactive",
  inputMuted: false,
  audibleOutput: "inactive",
  outputMuted: false,
  connectionGeneration: 0,
  reconnectAttempt: 0,
  diagnostic: null,
  error: null,
};

export function NewSessionRealtimeControl(props: {
  client?: RealtimeControllerClient | undefined;
  workspaceId?: string | undefined;
  codexConnected: boolean;
  disabled?: boolean | undefined;
  disabledReason?: string | null | undefined;
  onStart: (model: SessionRealtimeModel) => Promise<boolean>;
  /** Parent-owned selection (e.g. shared with the mobile “+” voice-model panel). */
  models?: readonly RealtimeModelOption[] | undefined;
  selectedModel?: RealtimeModelOption | undefined;
  onSelectModel?: ((modelId: string) => void) | undefined;
  /**
   * `split` attaches the model chevron at every breakpoint (public default).
   * `split-desktop` hides it below `sm` when the host owns mobile selection (e.g. “+”).
   * `none` never attaches a model menu to the bar button.
   */
  modelMenu?: "split" | "split-desktop" | "none" | undefined;
}) {
  const internalSelection = useRealtimeModelSelection({
    client: props.client,
    workspaceId: props.workspaceId,
    codexConnected: props.codexConnected,
  });
  const selection =
    props.models && props.selectedModel && props.onSelectModel
      ? {
          models: props.models,
          selectedModel: props.selectedModel,
          selectModel: props.onSelectModel,
        }
      : internalSelection;
  const audioRef = useRef<HTMLAudioElement>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot = useMemo<SessionRealtimeControllerSnapshot>(
    () =>
      starting
        ? { ...IDLE_REALTIME_SNAPSHOT, status: "starting" }
        : error
          ? { ...IDLE_REALTIME_SNAPSHOT, status: "error", error }
          : IDLE_REALTIME_SNAPSHOT,
    [error, starting],
  );
  const canStart = selection.selectedModel.available && props.disabled !== true && !starting;
  const onStart = props.onStart;
  const selectedModelId = selection.selectedModel.id;
  const start = useCallback(async () => {
    if (!canStart) return;
    setStarting(true);
    setError(null);
    try {
      const started = await onStart(selectedModelId);
      if (!started) setError("The voice session could not be created.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  }, [canStart, onStart, selectedModelId]);

  return (
    <RealtimeVoiceControl
      snapshot={snapshot}
      canStart={canStart}
      admissionBlocker={selection.selectedModel.unavailableReason ?? props.disabledReason ?? null}
      modelAvailable={selection.selectedModel.available}
      selectionDisabled={starting}
      menuSide="bottom"
      modelMenu={props.modelMenu ?? "split"}
      showDiagnostics={false}
      audioRef={audioRef}
      selectedModel={selection.selectedModel}
      models={selection.models}
      onSelectModel={selection.selectModel}
      onStart={start}
      onStop={async () => undefined}
      onRetry={start}
      onRetryAudibleOutput={async () => undefined}
      onSetInputMuted={() => undefined}
      onSetOutputMuted={() => undefined}
    />
  );
}

export function RealtimeVoiceControl(props: {
  snapshot: SessionRealtimeControllerSnapshot;
  canStart: boolean;
  admissionBlocker?: string | null | undefined;
  modelAvailable: boolean;
  selectionDisabled?: boolean | undefined;
  /** Prefer `bottom` on home/new-session; `top` for the docked session composer. */
  menuSide?: "top" | "bottom" | undefined;
  /**
   * `split` = start + model chevron at every breakpoint (public SDK default).
   * `split-desktop` = chevron from `sm` up; below that the host owns selection.
   * `none` = start button only.
   */
  modelMenu?: "split" | "split-desktop" | "none" | undefined;
  showDiagnostics?: boolean;
  /** Extra classes on the in-bar mute cluster (e.g. `max-sm:hidden` when mutes live in “+”). */
  muteControlsClassName?: string | undefined;
  audioRef: RefObject<HTMLAudioElement | null>;
  selectedModel?: RealtimeModelOption | undefined;
  models?: readonly RealtimeModelOption[] | undefined;
  onSelectModel?: ((modelId: string) => void) | undefined;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onRetry: () => Promise<void>;
  onRetryAudibleOutput: () => Promise<void>;
  onSetInputMuted: (muted: boolean) => void;
  onSetOutputMuted: (muted: boolean) => void;
}) {
  const reduceMotion = useReducedMotion();
  const selectedModel = props.selectedModel ?? {
    ...CODEX_LIVE_MODEL,
    available: props.modelAvailable,
    unavailableReason: props.modelAvailable ? null : CODEX_LIVE_MODEL.unavailableReason,
  };
  const models = props.models ?? [selectedModel];
  const status = statusContent(
    props.snapshot,
    props.modelAvailable,
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
  const audioBlocked = props.snapshot.audibleOutput === "blocked" && !props.snapshot.outputMuted;
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
  const modelMenu = props.modelMenu ?? "split";
  const showAttachedModelMenu = modelMenu === "split" || modelMenu === "split-desktop";
  const desktopOnlyModelMenu = modelMenu === "split-desktop";
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerProvider, setPickerProvider] = useState<RealtimeModelProvider | null>(
    selectedModel.provider,
  );
  const [pickerDirection, setPickerDirection] = useState<1 | -1>(1);

  useEffect(() => {
    if (!pickerOpen) setPickerProvider(selectedModel.provider);
  }, [pickerOpen, selectedModel.provider]);

  return (
    <div
      aria-label="Realtime voice"
      data-picker-side={props.menuSide ?? "top"}
      className="inline-flex shrink-0 items-center"
    >
      <audio ref={props.audioRef} autoPlay className="hidden" aria-hidden="true" />
      <RealtimeComposerGlow phase={status.phase} reduceMotion={reduceMotion === true} />
      <AnimatePresence initial={false}>
        {modeOwned ? (
          <motion.div
            key="realtime-mute-controls"
            data-testid="realtime-mute-controls"
            // After dictate collapses and the model slides left, bloom mutes
            // out from the primary voice control. Exit is immediate (no delay).
            initial={reduceMotion ? false : { opacity: 0, width: 0 }}
            animate={{
              opacity: 1,
              width: "auto",
              transition: reduceMotion
                ? { duration: 0 }
                : { delay: 0.3, duration: 0.48, ease: [0.22, 1, 0.36, 1] },
            }}
            {...(reduceMotion
              ? {}
              : {
                  exit: {
                    opacity: 0,
                    width: 0,
                    transition: { duration: 0.28, ease: [0.4, 0, 1, 1] },
                  },
                })}
            className={cn(
              "inline-flex shrink-0 items-center overflow-hidden",
              props.muteControlsClassName,
            )}
          >
            <motion.div
              className="inline-flex items-center gap-0.5 pr-1"
              initial={reduceMotion ? false : { x: 18, opacity: 0 }}
              animate={{
                x: 0,
                opacity: 1,
                transition: reduceMotion
                  ? { duration: 0 }
                  : { delay: 0.32, type: "spring", stiffness: 320, damping: 30, mass: 0.8 },
              }}
              {...(reduceMotion
                ? {}
                : {
                    exit: {
                      x: 14,
                      opacity: 0,
                      transition: { duration: 0.22, ease: [0.4, 0, 1, 1] },
                    },
                  })}
            >
              <RealtimeMuteButton
                muted={props.snapshot.inputMuted}
                kind="microphone"
                reduceMotion={reduceMotion === true}
                enterDelay={reduceMotion ? 0 : 0.34}
                onToggle={() => props.onSetInputMuted(!props.snapshot.inputMuted)}
              />
              <RealtimeMuteButton
                muted={props.snapshot.outputMuted}
                kind="output"
                reduceMotion={reduceMotion === true}
                enterDelay={reduceMotion ? 0 : 0.4}
                onToggle={() => props.onSetOutputMuted(!props.snapshot.outputMuted)}
              />
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <div className="inline-flex shrink-0 items-center">
        <motion.button
          type="button"
          data-testid="realtime-primary-action"
          data-phase={status.phase}
          aria-label={mainLabel}
          aria-pressed={modeOwned}
          title={mainLabel}
          disabled={mainDisabled}
          {...(reduceMotion ? {} : { whileTap: { scale: 0.92 } })}
          transition={{ type: "spring", stiffness: 520, damping: 30 }}
          onClick={() => void runMainAction().catch(() => undefined)}
          className={cn(
            // Match transcription mic: ghost icon when idle; filled only when live.
            // Public contract: coarse pointers keep a 44px target; split menu uses
            // left-only rounding at `sm+` where the chevron attaches.
            "relative inline-flex size-8 items-center justify-center outline-none",
            "rounded-og-md transition-[background-color,border-color,color,box-shadow] duration-200 ease-og-out",
            "focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-og-accent/45",
            "disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:size-11",
            showAttachedModelMenu &&
              (desktopOnlyModelMenu
                ? "sm:rounded-l-og-md sm:rounded-r-none"
                : "rounded-l-og-md rounded-r-none"),
            voiceButtonTone(status.phase),
          )}
        >
          <RealtimeActionGlyph
            phase={status.phase}
            audioBlocked={audioBlocked}
            reduceMotion={reduceMotion === true}
          />
        </motion.button>

        {showAttachedModelMenu ? (
          <DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Choose voice model and options"
                title={`Voice model: ${selectedModel.label}`}
                disabled={props.selectionDisabled}
                className={cn(
                  "inline-flex h-8 w-5 items-center justify-center rounded-r-og-md outline-none",
                  "transition-[background-color,border-color,color] duration-200 ease-og-out",
                  "focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-og-accent/45",
                  "pointer-coarse:h-11 pointer-coarse:w-7",
                  desktopOnlyModelMenu && "hidden sm:inline-flex",
                  voiceChevronTone(status.phase),
                )}
              >
                <ChevronDownIcon className="size-3" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side={props.menuSide ?? "top"}
              align="end"
              sideOffset={8}
              collisionPadding={12}
              className="flex w-72 max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] flex-col overflow-hidden rounded-xl border-border bg-surface p-1.5 shadow-xl"
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <RealtimeModelPickerMenu
                  models={models}
                  selectedModel={selectedModel}
                  provider={pickerProvider}
                  direction={pickerDirection}
                  disabled={
                    props.selectionDisabled === true || props.snapshot.mode?.state === "active"
                  }
                  onProviderChange={(provider, direction) => {
                    setPickerDirection(direction);
                    setPickerProvider(provider);
                  }}
                  onSelect={(modelId) => {
                    props.onSelectModel?.(modelId);
                    setPickerOpen(false);
                  }}
                />
              </div>

              {status.phase !== "idle" ? (
                <>
                  <DropdownMenuSeparator className="mx-1 bg-og-border" />
                  <div className="px-2.5 py-2" role="status" aria-live="polite">
                    <div className="flex items-center gap-2 text-og-sm font-medium text-og-fg">
                      <RealtimeStatusDot
                        phase={status.phase}
                        reduceMotion={reduceMotion === true}
                      />
                      {status.label}
                    </div>
                    <p className="mt-1 text-og-xs leading-5 text-og-fg-subtle">{status.detail}</p>
                  </div>
                </>
              ) : null}

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
        ) : null}
      </div>

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

/** Drill-in body for the mobile composer “+” menu — same catalog as the desktop chevron. */
export function RealtimeVoiceModelPanel(props: {
  models: readonly RealtimeModelOption[];
  selectedModel: RealtimeModelOption;
  disabled?: boolean | undefined;
  leading?: ReactNode | undefined;
  onSelect: (modelId: SessionRealtimeModel) => void;
}) {
  const [provider, setProvider] = useState<RealtimeModelProvider | null>(null);
  const [direction, setDirection] = useState<1 | -1>(1);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="realtime-voice-model-panel">
      <div className="flex shrink-0 items-start gap-1 px-2 pt-1 pb-1.5">
        {props.leading}
        <div className="min-w-0">
          <div className="text-sm font-medium text-og-fg">Voice model</div>
          <p className="mt-0.5 text-xs text-og-fg-subtle">
            Used when you start a voice conversation.
          </p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
        <RealtimeModelPickerMenu
          models={props.models}
          selectedModel={props.selectedModel}
          provider={provider}
          direction={direction}
          disabled={props.disabled === true}
          onProviderChange={(next, nextDirection) => {
            setDirection(nextDirection);
            setProvider(next);
          }}
          onSelect={props.onSelect}
        />
      </div>
    </div>
  );
}

function RealtimeMuteButton(props: {
  muted: boolean;
  kind: "microphone" | "output";
  reduceMotion: boolean;
  enterDelay?: number | undefined;
  onToggle(): void;
}) {
  const microphone = props.kind === "microphone";
  const label = microphone
    ? props.muted
      ? "Unmute microphone"
      : "Mute microphone"
    : props.muted
      ? "Unmute voice audio"
      : "Mute voice audio";
  const Icon = microphone
    ? props.muted
      ? MicOffIcon
      : MicIcon
    : props.muted
      ? VolumeXIcon
      : Volume2Icon;

  return (
    <motion.button
      type="button"
      aria-label={label}
      aria-pressed={props.muted}
      title={label}
      initial={props.reduceMotion ? false : { scale: 0.72, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{
        delay: props.enterDelay ?? 0,
        type: "spring",
        stiffness: 420,
        damping: 26,
        mass: 0.7,
      }}
      {...(props.reduceMotion ? {} : { whileTap: { scale: 0.92 } })}
      onClick={props.onToggle}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-og-md outline-none",
        "transition-[background-color,border-color,color] duration-150 ease-og-out",
        "focus-visible:ring-2 focus-visible:ring-og-accent/45 pointer-coarse:size-11",
        props.muted
          ? "border border-og-accent/35 bg-og-accent-soft text-og-accent"
          : "text-og-fg-muted hover:bg-og-surface-2 hover:text-og-fg",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
    </motion.button>
  );
}

export function RealtimeModelPickerMenu(props: {
  models: readonly RealtimeModelOption[];
  selectedModel: RealtimeModelOption;
  provider: RealtimeModelProvider | null;
  direction: 1 | -1;
  disabled: boolean;
  onProviderChange: (provider: RealtimeModelProvider | null, direction: 1 | -1) => void;
  onSelect: (modelId: SessionRealtimeModel) => void;
}) {
  const providers = REALTIME_MODEL_PROVIDERS.filter((provider) =>
    props.models.some((model) => model.provider === provider),
  );
  const pageKey = props.provider ? `voice-models:${props.provider}` : "voice-providers";
  const body = props.provider ? (
    <div data-testid="realtime-model-picker-models">
      <PickerBackHeader
        label={props.provider}
        icon={
          <BillingClassMark
            billingClass={REALTIME_PROVIDER_META[props.provider].billingClass}
            aria-label=""
          />
        }
        onBack={() => props.onProviderChange(null, -1)}
      />
      <div className="flex flex-col gap-0.5">
        {props.models
          .filter((model) => model.provider === props.provider)
          .map((model) => {
            const selected = model.id === props.selectedModel.id;
            return (
              <PickerNavRow
                key={model.id}
                label={model.label}
                hint={
                  model.unavailableReason ??
                  (model.recommended ? `Recommended · ${model.description}` : model.description)
                }
                disabled={props.disabled || !model.available}
                title={model.unavailableReason ?? model.description}
                active={selected}
                showChevron={false}
                trailing={selected ? <CheckIcon className="size-3.5" aria-hidden /> : undefined}
                testId={`realtime-model-choice-${model.id}`}
                onClick={() => props.onSelect(model.id)}
              />
            );
          })}
      </div>
    </div>
  ) : (
    <div className="flex flex-col gap-0.5" data-testid="realtime-model-picker-providers">
      {providers.map((provider) => {
        const meta = REALTIME_PROVIDER_META[provider];
        return (
          <PickerNavRow
            key={provider}
            label={provider}
            hint={meta.hint}
            icon={<BillingClassMark billingClass={meta.billingClass} aria-label="" />}
            active={props.selectedModel.provider === provider}
            testId={`realtime-model-provider-${meta.billingClass}`}
            onClick={() => props.onProviderChange(provider, 1)}
          />
        );
      })}
    </div>
  );

  return (
    <div className="relative overflow-hidden" data-testid="realtime-model-picker-menu">
      <PickerAnimatedPage pageKey={pageKey} direction={props.direction}>
        {body}
      </PickerAnimatedPage>
    </div>
  );
}

function RealtimeDiagnosticsMenu({ snapshot }: { snapshot: SessionRealtimeControllerSnapshot }) {
  const bridge = snapshot.bridge;
  const rows = [
    ["controller", snapshot.status],
    ["microphone", snapshot.microphone],
    ["microphone muted", String(snapshot.inputMuted)],
    ["audio", snapshot.audibleOutput],
    ["audio muted", String(snapshot.outputMuted)],
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
  snapshot: SessionRealtimeControllerSnapshot,
  modelAvailable: boolean,
  canStart: boolean,
  admissionBlocker: string | null,
  modelLabel: string,
): { phase: RealtimeVisualPhase; label: string; detail: string } {
  if (snapshot.audibleOutput === "blocked" && !snapshot.outputMuted) {
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
      if (!modelAvailable) {
        return {
          phase: "unavailable",
          label: "Voice model unavailable",
          detail: admissionBlocker ?? "Choose another voice model.",
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
    return "border border-og-accent/45 bg-og-accent text-og-accent-fg shadow-og-sm hover:bg-og-accent-strong";
  }
  if (phase === "blocked" || phase === "error") {
    return "border border-og-status-waiting/35 bg-og-status-waiting/10 text-og-status-waiting hover:bg-og-status-waiting/15";
  }
  if (phase === "connecting" || phase === "reconnecting" || phase === "stopping") {
    return "border border-og-accent/35 bg-og-accent-soft text-og-accent";
  }
  // Idle: same ghost treatment as the composer transcription mic — no box.
  return "text-og-fg-muted hover:bg-og-surface-2 hover:text-og-fg";
}

function voiceChevronTone(phase: RealtimeVisualPhase): string {
  if (phase === "listening" || phase === "speaking") {
    return "border border-l-0 border-og-accent/45 bg-og-accent text-og-accent-fg hover:bg-og-accent-strong";
  }
  if (phase === "blocked" || phase === "error") {
    return "border border-l-0 border-og-status-waiting/35 bg-og-status-waiting/10 text-og-status-waiting hover:bg-og-status-waiting/15";
  }
  if (phase === "connecting" || phase === "reconnecting" || phase === "stopping") {
    return "border border-l-0 border-og-accent/35 bg-og-accent-soft text-og-accent";
  }
  return "text-og-fg-muted hover:bg-og-surface-2 hover:text-og-fg";
}

function toRealtimeModelOption(model: WorkspaceRealtimeModelCatalogItem): RealtimeModelOption {
  return { ...model };
}

function readRealtimeModelPreference(workspaceId: string): SessionRealtimeModel | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const value = localStorage.getItem(`${REALTIME_MODEL_STORAGE_PREFIX}:${workspaceId}`);
    return isRealtimeModel(value) ? value : null;
  } catch {
    return null;
  }
}

function writeRealtimeModelPreference(workspaceId: string, model: SessionRealtimeModel): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(`${REALTIME_MODEL_STORAGE_PREFIX}:${workspaceId}`, model);
  } catch {
    // Voice selection still works when browser storage is unavailable.
  }
}

function isRealtimeModel(value: string | null): value is SessionRealtimeModel {
  return (
    value === "gpt-live-1-boulder-alpha" ||
    value === "opengeni-gateway/openai/gpt-realtime-2.1" ||
    value === "opengeni-gateway/openai/gpt-realtime-mini" ||
    value === "opengeni-gateway/xai/grok-voice-think-fast-2.0" ||
    value === "workspace-gateway/openai/gpt-realtime-2.1" ||
    value === "workspace-gateway/openai/gpt-realtime-mini" ||
    value === "workspace-gateway/xai/grok-voice-think-fast-2.0"
  );
}

/** @deprecated Use the provider-neutral realtime names. */
export const useSessionCodexRealtime = useSessionRealtime;
/** @deprecated Use the provider-neutral realtime names. */
export const useWorkspaceRealtimeModelSelection = useRealtimeModelSelection;
/** @deprecated Use the provider-neutral realtime names. */
export const SessionCodexRealtimeControl = SessionRealtimeControl;
/** @deprecated Use the provider-neutral realtime names. */
export const CodexRealtimeControl = RealtimeVoiceControl;
