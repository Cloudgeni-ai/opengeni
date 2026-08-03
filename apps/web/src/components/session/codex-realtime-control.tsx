import {
  projectSessionRealtimeLifecycle,
  type CodexRealtimeController,
  type CodexRealtimeControllerClient,
  type CodexRealtimeControllerSnapshot,
  type EffectiveSessionControl,
  type SessionEvent,
  type SessionRealtimeModel,
  type SessionStatus,
  type WorkspaceRealtimeModelCatalogItem,
  type WorkspaceRealtimeModelCatalogResponse,
} from "@opengeni/sdk";
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
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BillingClassMark, type BillingClass } from "@/components/billing-class-mark";
import { PickerAnimatedPage, PickerBackHeader, PickerNavRow } from "@/components/pickers";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

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

type RealtimeControllerClient = CodexRealtimeControllerClient & {
  getWorkspaceRealtimeModelCatalog?(
    workspaceId: string,
  ): Promise<WorkspaceRealtimeModelCatalogResponse>;
};

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
  client: RealtimeControllerClient;
  workspaceId: string;
  sessionId: string;
  sessionStatus: SessionStatus;
  effectiveControl: EffectiveSessionControl;
  events: SessionEvent[];
  eventsReady: boolean;
  codexConnected: boolean;
  model?: SessionRealtimeModel | undefined;
  modelAvailable?: boolean | undefined;
  modelUnavailableReason?: string | null | undefined;
}) {
  const model = options.model ?? CODEX_LIVE_MODEL.id;
  const audioRef = useRef<HTMLAudioElement>(null);
  const controllerRef = useRef<CodexRealtimeController | null>(null);
  const controllerModelRef = useRef<SessionRealtimeModel | null>(null);
  const [snapshot, setSnapshot] = useState<CodexRealtimeControllerSnapshot>(() => ({
    status: hasStoredOwnerProof(options.workspaceId, options.sessionId, model)
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
    let controller: CodexRealtimeController | null = null;
    let unsubscribe: (() => void) | null = null;
    void Promise.all([
      import("@opengeni/sdk/codex-realtime-controller"),
      model === CODEX_LIVE_MODEL.id
        ? Promise.resolve(null)
        : import("@opengeni/sdk/gateway-realtime-transport"),
    ])
      .then(([{ createCodexRealtimeController }, gateway]) => {
        if (disposed) return;
        controller = createCodexRealtimeController({
          client: options.client,
          workspaceId: options.workspaceId,
          sessionId: options.sessionId,
          ...(audioRef.current ? { remoteAudio: audioRef.current } : {}),
          ...(model === CODEX_LIVE_MODEL.id
            ? {}
            : {
                model,
                ownerStorageNamespace: "gateway-realtime-owner",
                startTransport: gateway!.createGatewayRealtimeTransportStarter(),
              }),
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
  }, [model, options.client, options.sessionId, options.workspaceId]);

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

function hasStoredOwnerProof(
  workspaceId: string,
  sessionId: string,
  model: SessionRealtimeModel,
): boolean {
  if (typeof sessionStorage === "undefined") return false;
  try {
    return (
      sessionStorage.getItem(
        `opengeni:${model === CODEX_LIVE_MODEL.id ? "codex" : "gateway"}-realtime-owner:${workspaceId}:${sessionId}`,
      ) !== null
    );
  } catch {
    return false;
  }
}

export function SessionCodexRealtimeControl(props: {
  client: RealtimeControllerClient;
  workspaceId: string;
  sessionId: string;
  sessionStatus: SessionStatus;
  effectiveControl: EffectiveSessionControl;
  events: SessionEvent[];
  eventsReady: boolean;
  codexConnected: boolean;
  realtimeAutostartModel?: SessionRealtimeModel | undefined;
  onRealtimeAutostartConsumed?: (() => void) | undefined;
}) {
  const lifecycle = useMemo(() => projectSessionRealtimeLifecycle(props.events), [props.events]);
  const selection = useWorkspaceRealtimeModelSelection({
    client: props.client,
    workspaceId: props.workspaceId,
    codexConnected: props.codexConnected,
    activeModel: lifecycle?.state === "active" ? lifecycle.model : null,
  });
  const selectedModel = selection.selectedModel;
  const realtime = useSessionCodexRealtime({
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
    <CodexRealtimeControl
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

export function useWorkspaceRealtimeModelSelection(options: {
  client: RealtimeControllerClient;
  workspaceId: string;
  codexConnected: boolean;
  activeModel?: SessionRealtimeModel | null | undefined;
}) {
  const activeModel = options.activeModel;
  const [catalog, setCatalog] = useState<RealtimeModelOption[]>(() => [
    {
      ...CODEX_LIVE_MODEL,
      available: options.codexConnected,
      unavailableReason: options.codexConnected ? null : CODEX_LIVE_MODEL.unavailableReason,
    },
  ]);
  const [selectedModelId, setSelectedModelId] = useState<SessionRealtimeModel>(
    () => readRealtimeModelPreference(options.workspaceId) ?? CODEX_LIVE_MODEL.id,
  );

  useEffect(() => {
    let disposed = false;
    const load = options.client.getWorkspaceRealtimeModelCatalog;
    if (!load) return;
    void load
      .call(options.client, options.workspaceId)
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
  }, [options.client, options.workspaceId]);

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
      writeRealtimeModelPreference(options.workspaceId, model.id);
    },
    [activeModel, catalog, options.workspaceId],
  );

  return { models: catalog, selectedModel, selectModel };
}

const IDLE_REALTIME_SNAPSHOT: CodexRealtimeControllerSnapshot = {
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
  client: RealtimeControllerClient;
  workspaceId: string;
  codexConnected: boolean;
  disabled?: boolean | undefined;
  disabledReason?: string | null | undefined;
  onStart: (model: SessionRealtimeModel) => Promise<boolean>;
}) {
  const selection = useWorkspaceRealtimeModelSelection({
    client: props.client,
    workspaceId: props.workspaceId,
    codexConnected: props.codexConnected,
  });
  const audioRef = useRef<HTMLAudioElement>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot = useMemo<CodexRealtimeControllerSnapshot>(
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
    <CodexRealtimeControl
      snapshot={snapshot}
      canStart={canStart}
      admissionBlocker={selection.selectedModel.unavailableReason ?? props.disabledReason ?? null}
      modelAvailable={selection.selectedModel.available}
      selectionDisabled={starting}
      menuSide="bottom"
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

export function CodexRealtimeControl(props: {
  snapshot: CodexRealtimeControllerSnapshot;
  canStart: boolean;
  admissionBlocker?: string | null | undefined;
  modelAvailable: boolean;
  selectionDisabled?: boolean | undefined;
  /** Prefer `bottom` on home/new-session; `top` for the docked session composer. */
  menuSide?: "top" | "bottom" | undefined;
  showDiagnostics?: boolean;
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
            initial={reduceMotion ? false : { opacity: 0, width: 0, marginRight: 0 }}
            animate={{ opacity: 1, width: "auto", marginRight: 4 }}
            exit={reduceMotion ? undefined : { opacity: 0, width: 0, marginRight: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.2, 0.8, 0.2, 1] }}
            className="inline-flex shrink-0 items-center gap-0.5 overflow-hidden"
          >
            <RealtimeMuteButton
              muted={props.snapshot.inputMuted}
              kind="microphone"
              reduceMotion={reduceMotion === true}
              onToggle={() => props.onSetInputMuted(!props.snapshot.inputMuted)}
            />
            <RealtimeMuteButton
              muted={props.snapshot.outputMuted}
              kind="output"
              reduceMotion={reduceMotion === true}
              onToggle={() => props.onSetOutputMuted(!props.snapshot.outputMuted)}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
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

      <DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Choose voice model and options"
            title={`Voice model: ${selectedModel.label}`}
            disabled={props.selectionDisabled}
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
              disabled={props.selectionDisabled === true || props.snapshot.mode?.state === "active"}
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
                  <RealtimeStatusDot phase={status.phase} reduceMotion={reduceMotion === true} />
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

function RealtimeMuteButton(props: {
  muted: boolean;
  kind: "microphone" | "output";
  reduceMotion: boolean;
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
      whileTap={props.reduceMotion ? undefined : { scale: 0.92 }}
      onClick={props.onToggle}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-og-md border outline-none",
        "transition-[background-color,border-color,color] duration-150 ease-og-out",
        "focus-visible:ring-2 focus-visible:ring-og-accent/45 pointer-coarse:size-11",
        props.muted
          ? "border-og-accent/35 bg-og-accent-soft text-og-accent"
          : "border-og-border bg-og-surface-2 text-og-fg-muted hover:border-og-accent/35 hover:text-og-fg",
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

function RealtimeDiagnosticsMenu({ snapshot }: { snapshot: CodexRealtimeControllerSnapshot }) {
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
  snapshot: CodexRealtimeControllerSnapshot,
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
