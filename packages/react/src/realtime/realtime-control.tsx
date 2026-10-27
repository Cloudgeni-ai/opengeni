import {
  COMPOSER_VOICE_INPUT_START_EVENT,
  composerVoiceEventScope,
} from "../composer-voice-events";
import { type EffectiveSessionControl, type SessionEvent, type SessionStatus } from "@opengeni/sdk";
import {
  projectSessionRealtimeLifecycle,
  type SessionRealtimeControllerSnapshot,
  type RealtimeVoiceSettings,
  type SessionRealtimeModel,
} from "@opengeni/sdk/realtime";
import {
  AudioLinesIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  LanguagesIcon,
  LoaderCircleIcon,
  MicIcon,
  MicOffIcon,
  RotateCcwIcon,
  SquareIcon,
  Volume2Icon,
  VolumeXIcon,
  XIcon,
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
import { cn } from "../lib/cn";
import { useComposerFooterSignal } from "../lib/composer-footer-signals";
import type { PickerBillingClass as BillingClass } from "../model-policy";
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
import { MENU_CHECK_CLASS } from "../lib/menu-styles";
import {
  CODEX_LIVE_MODEL,
  realtimeAppLanguage,
  type RealtimeControllerClient,
  type RealtimeLoadState,
  type RealtimeModelOption,
  type SessionRealtimeControllerFactory,
  sessionRealtimeLifecycleIsActive,
  useRealtimeLanguagePreference,
  useRealtimeModelSelection,
  useSessionRealtime,
} from "./session-realtime";
import { type MicrophoneAccess, useMicrophoneAccess } from "./microphone-access";
import { useOpenGeniText, type OpenGeniText } from "../messages/runtime";

export {
  codexRealtimeAdmissionAllowed,
  codexRealtimeAdmissionBlocker,
  CODEX_LIVE_MODEL,
  prestartSessionRealtime,
  realtimeAppLanguage,
  realtimeConversationLanguage,
  sessionRealtimeLifecycleIsActive,
  useRealtimeLanguagePreference,
  useRealtimeModelSelection,
  useSessionRealtime,
} from "./session-realtime";
export type {
  RealtimeLoadState,
  RealtimeModelOption,
  SessionRealtimeControllerFactory,
} from "./session-realtime";
export type { MicrophoneAccess } from "./microphone-access";

/** Short status label for a credit/availability refusal (shared with the model menu). */
function realtimeRefusalLabel(t: OpenGeniText, code: string | null | undefined): string | null {
  switch (code) {
    case "insufficient_credits":
      return t("realtime.realtimeControl.creditsNeeded");
    case "allowance_exhausted":
    case "monthly_model_cost_limit":
      return t("realtime.realtimeControl.usageLimitReached");
    case "realtime_voice_unavailable":
      return t("realtime.realtimeControl.voiceUnavailable");
    case "credits_disabled":
      return t("realtime.realtimeControl.creditsOff");
    default:
      return null;
  }
}

// Wire identifiers of the realtime catalog provider field; display names come from REALTIME_PROVIDER_META.
const REALTIME_MODEL_PROVIDERS = [
  "OpenGeni",
  "Connected Codex",
  "Connected SuperGrok",
  "Your Gateway",
  "Your ElevenLabs",
] as const;
type RealtimeModelProvider = (typeof REALTIME_MODEL_PROVIDERS)[number];

const REALTIME_PROVIDER_META = (
  t: OpenGeniText,
): Record<
  RealtimeModelProvider,
  // `key` is unique per provider; several providers can share a billing class.
  { key: string; billingClass: BillingClass; label: string; hint: string }
> => ({
  // The wire value keeps its historical spelling; the product name is Opengeni.
  OpenGeni: {
    key: "opengeni",
    billingClass: "opengeni_credits",
    label: t("realtime.realtimeControl.opengeni"),
    hint: t("realtime.realtimeControl.usesOpengeniCredits"),
  },
  "Connected Codex": {
    key: "codex",
    billingClass: "codex_subscription",
    label: t("realtime.realtimeControl.connectedCodex"),
    hint: t("realtime.realtimeControl.chatgptCodexPlan"),
  },
  "Connected SuperGrok": {
    key: "supergrok",
    billingClass: "supergrok_subscription",
    label: t("realtime.realtimeControl.connectedSupergrok"),
    hint: t("realtime.realtimeControl.supergrokXaiPlan"),
  },
  "Your Gateway": {
    key: "gateway",
    billingClass: "byok",
    label: t("realtime.realtimeControl.yourGateway"),
    hint: t("realtime.realtimeControl.billedToYourAiGateway"),
  },
  "Your ElevenLabs": {
    key: "elevenlabs",
    billingClass: "byok",
    label: t("realtime.realtimeControl.yourElevenlabs"),
    hint: t("realtime.realtimeControl.billedToYourElevenlabs"),
  },
});
/** Display name; the catalog's `provider` value stays the wire identifier. */
function realtimeProviderLabel(t: OpenGeniText, provider: RealtimeModelProvider): string {
  return REALTIME_PROVIDER_META(t)[provider].label;
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
  /** Model-visible application context captured with each durable realtime message. */
  getModelContext?: (() => string | undefined) | undefined;
  realtimeAutostartModel?: SessionRealtimeModel | undefined;
  onRealtimeAutostartConsumed?: (() => void) | undefined;
  /** Host hides dictate (and can choreograph layout) while realtime voice is live. */
  onVoiceActiveChange?: ((active: boolean) => void) | undefined;
  /**
   * `split` attaches the model chevron at every breakpoint (public default).
   * `split-desktop` hides it below `sm` when the host owns mobile selection.
   * Inside a container-responsive Composer.Root, `sm` follows that composer.
   * `none` never attaches a model menu to the bar button.
   */
  modelMenu?: "split" | "split-desktop" | "none" | undefined;
  /** Explicitly expose low-level controller diagnostics; disabled by default. */
  showDiagnostics?: boolean | undefined;
  /**
   * Voice settings for this session's voice (voice, language, turn eagerness),
   * over the workspace's saved settings for the selected model. A language the
   * person picks in the voice menu takes precedence. Settings the selected
   * model does not offer are ignored.
   */
  voiceSettings?: RealtimeVoiceSettings | undefined;
  /** Deterministic browser-test/demo seam. Production hosts should use the SDK default. */
  controllerFactory?: SessionRealtimeControllerFactory | undefined;
}) {
  const lifecycle = useMemo(() => projectSessionRealtimeLifecycle(props.events), [props.events]);
  const lifecycleActive = sessionRealtimeLifecycleIsActive(lifecycle);
  const selection = useRealtimeModelSelection({
    client: props.client,
    workspaceId: props.workspaceId,
    codexConnected: props.codexConnected,
    activeModel: lifecycleActive && lifecycle?.state === "active" ? lifecycle.model : null,
  });
  const selectedModel = selection.selectedModel;
  const realtime = useSessionRealtime({
    ...props,
    model: selectedModel.id,
    modelAvailable: selectedModel.available,
    modelUnavailableReason: selectedModel.unavailableReason,
    language: selection.languageFor(selectedModel.id),
    voiceSettings: selection.voiceSettingsFor(selectedModel.id, props.voiceSettings),
  });
  const autostartModelRef = useRef(props.realtimeAutostartModel ?? null);
  const autostartStartedRef = useRef(false);

  const { models, selectedModel: selectedRealtimeModel, selectModel } = selection;
  const { canStart, start, prestarted } = realtime;
  const onRealtimeAutostartConsumed = props.onRealtimeAutostartConsumed;
  const onVoiceActiveChange = props.onVoiceActiveChange;
  const voiceActive = realtime.snapshot.mode?.state === "active";

  useEffect(() => {
    onVoiceActiveChange?.(voiceActive);
  }, [onVoiceActiveChange, voiceActive]);
  useEffect(() => () => onVoiceActiveChange?.(false), [onVoiceActiveChange]);

  useEffect(() => {
    const pending = autostartModelRef.current;
    if (!pending || autostartStartedRef.current) return;
    const consume = () => {
      autostartModelRef.current = null;
      onRealtimeAutostartConsumed?.();
    };
    if (prestarted && selectedRealtimeModel.id === pending) {
      // The host started this call before the view mounted; it is the autostart.
      autostartStartedRef.current = true;
      consume();
      return;
    }
    if (lifecycleActive) return;
    const available = models.some((model) => model.id === pending && model.available);
    if (!available) return;
    if (selectedRealtimeModel.id !== pending) {
      selectModel(pending);
      return;
    }
    if (!canStart) return;
    autostartStartedRef.current = true;
    // One automatic attempt. A failed start stays visible with its reason and
    // the user retries explicitly; re-arming would loop on a definitive refusal.
    void start().then(consume, consume);
  }, [
    canStart,
    lifecycleActive,
    models,
    prestarted,
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
      loadState={selection.loadState}
      menuSide="top"
      modelMenu={props.modelMenu ?? "split"}
      showDiagnostics={props.showDiagnostics}
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

type NewSessionRealtimeControlProps = {
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
   * With parent-owned selection: whether what voice needs here has loaded, such
   * as that selection's `loadState`. A host can report `loading` while its own
   * start conditions are still loading, so a passing blocker is not shown.
   */
  loadState?: RealtimeLoadState | undefined;
  /**
   * `split` attaches the model chevron at every breakpoint (public default).
   * `split-desktop` hides it below `sm` when the host owns mobile selection (e.g. “+”).
   * Inside a container-responsive Composer.Root, `sm` follows that composer.
   * `none` never attaches a model menu to the bar button.
   */
  modelMenu?: "split" | "split-desktop" | "none" | undefined;
};

type NewSessionRealtimeSelection = {
  models: readonly RealtimeModelOption[];
  selectedModel: RealtimeModelOption;
  selectModel: (modelId: string) => void;
  loadState?: RealtimeLoadState | undefined;
};

export function NewSessionRealtimeControl(props: NewSessionRealtimeControlProps) {
  if (props.models && props.selectedModel && props.onSelectModel) {
    return (
      <NewSessionRealtimeControlView
        {...props}
        selection={{
          models: props.models,
          selectedModel: props.selectedModel,
          selectModel: props.onSelectModel,
          loadState: props.loadState,
        }}
      />
    );
  }
  return <NewSessionRealtimeControlWithInternalSelection {...props} />;
}

function NewSessionRealtimeControlWithInternalSelection(props: NewSessionRealtimeControlProps) {
  const selection = useRealtimeModelSelection({
    client: props.client,
    workspaceId: props.workspaceId,
    codexConnected: props.codexConnected,
  });
  return <NewSessionRealtimeControlView {...props} selection={selection} />;
}

function NewSessionRealtimeControlView(
  props: NewSessionRealtimeControlProps & { selection: NewSessionRealtimeSelection },
) {
  const t = useOpenGeniText();
  const selection = props.selection;
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
      if (!started) setError(t("realtime.realtimeControl.theVoiceSessionCouldNot"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  }, [canStart, onStart, selectedModelId, t]);

  return (
    <RealtimeVoiceControl
      snapshot={snapshot}
      canStart={canStart}
      admissionBlocker={selection.selectedModel.unavailableReason ?? props.disabledReason ?? null}
      modelAvailable={selection.selectedModel.available}
      loadState={selection.loadState}
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
  /**
   * Whether what voice needs here has loaded (`ready` by default). While
   * `loading`, a blocker reads as "Checking voice" instead of a setup step;
   * `failed` says voice couldn't load.
   */
  loadState?: RealtimeLoadState | undefined;
  selectionDisabled?: boolean | undefined;
  /** Prefer `bottom` on home/new-session; `top` for the docked session composer. */
  menuSide?: "top" | "bottom" | undefined;
  /**
   * `split` = start + model chevron at every breakpoint (public SDK default).
   * `split-desktop` = chevron from `sm` up; below that the host owns selection.
   * Inside a container-responsive Composer.Root, `sm` follows that composer.
   * `none` = start button only.
   */
  modelMenu?: "split" | "split-desktop" | "none" | undefined;
  showDiagnostics?: boolean | undefined;
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
  const t = useOpenGeniText();
  const reduceMotion = useReducedMotion();
  const selectedModel = props.selectedModel ?? {
    ...CODEX_LIVE_MODEL(t),
    available: props.modelAvailable,
    unavailableReason: props.modelAvailable ? null : CODEX_LIVE_MODEL(t).unavailableReason,
  };
  const models = props.models ?? [selectedModel];
  // A page that can't use the microphone can't start voice; say so up front
  // rather than after a start that would fail.
  const microphone = useMicrophoneAccess();
  const startable = props.canStart && microphone === "unknown";
  // Until the catalog is known, the list holds only a placeholder Codex Live;
  // list it only once it is real or usable.
  const modelsKnown = (props.loadState ?? "ready") === "ready" || props.modelAvailable;
  const status = statusContent(
    t,
    props.snapshot,
    props.modelAvailable,
    props.canStart,
    props.admissionBlocker ?? null,
    selectedModel.unavailableCode ?? null,
    props.loadState ?? "ready",
    microphone,
  );
  const modeOwned = props.snapshot.mode?.state === "active";
  const retryConnection =
    modeOwned &&
    props.snapshot.status !== "stopping" &&
    props.snapshot.status !== "active" &&
    props.snapshot.diagnostic?.recoverable === true;
  const audioBlocked = props.snapshot.audibleOutput === "blocked" && !props.snapshot.outputMuted;
  // A call that ended in a failure keeps its reason on screen, not only in a
  // tooltip or the model menu, until the user starts again or changes model.
  const startFailed = props.snapshot.status === "error" && !modeOwned;
  const failureText =
    status.label === t("realtime.realtimeControl.voiceUnavailable")
      ? status.detail
      : t("realtime.realtimeControl.labelDetail", { label: status.label, detail: status.detail });
  const mainDisabled =
    props.snapshot.status === "stopping" ||
    props.snapshot.status === "lost_owner" ||
    (!modeOwned && !startable) ||
    (props.snapshot.status === "starting" && !modeOwned);
  const mainLabel = audioBlocked
    ? t("realtime.realtimeControl.resumeVoiceAudio")
    : retryConnection
      ? t("realtime.realtimeControl.retryVoiceConnection")
      : modeOwned
        ? t("realtime.realtimeControl.endVoiceConversation")
        : !startable && (status.phase === "unavailable" || status.phase === "checking")
          ? `${status.label}: ${status.detail}`
          : startFailed
            ? t("realtime.realtimeControl.tryVoiceAgain")
            : t("realtime.realtimeControl.startVoice");
  const runMainAction = audioBlocked
    ? props.onRetryAudibleOutput
    : retryConnection
      ? props.onRetry
      : modeOwned
        ? props.onStop
        : props.onStart;
  const diagnosticsVisible = props.showDiagnostics ?? false;
  const modelMenu = props.modelMenu ?? "split";
  const showAttachedModelMenu = modelMenu === "split" || modelMenu === "split-desktop";
  const desktopOnlyModelMenu = modelMenu === "split-desktop";
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerProvider, setPickerProvider] = useState<RealtimeModelProvider | null>(
    selectedModel.provider,
  );
  const [pickerDirection, setPickerDirection] = useState<1 | -1>(1);
  const [failureDismissed, setFailureDismissed] = useState(false);
  useEffect(() => {
    if (!startFailed) setFailureDismissed(false);
  }, [startFailed]);
  useComposerFooterSignal("realtime-attention", startFailed && !failureDismissed);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!startFailed) return;
    // Starting dictation in this composer supersedes a stale start failure.
    const scope = composerVoiceEventScope(rootRef.current);
    if (!scope) return;
    const dismiss = () => setFailureDismissed(true);
    scope.addEventListener(COMPOSER_VOICE_INPUT_START_EVENT, dismiss);
    return () => scope.removeEventListener(COMPOSER_VOICE_INPUT_START_EVENT, dismiss);
  }, [startFailed]);

  useEffect(() => {
    if (!pickerOpen) setPickerProvider(selectedModel.provider);
  }, [pickerOpen, selectedModel.provider]);

  // No voice model can run here yet (none is connected): show no control
  // rather than a disabled one that explains a setup step to someone who
  // never asked for voice. It appears once a voice model is available, and
  // never hides a conversation or a failure that is still on screen.
  if (!models.some((model) => model.available) && props.snapshot.status === "idle" && !modeOwned)
    return null;

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={t("realtime.realtimeControl.realtimeVoice")}
      data-picker-side={props.menuSide ?? "top"}
      data-model-menu={modelMenu}
      className="og-realtime-control inline-flex shrink-0 items-center"
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
                  : {
                      delay: 0.32,
                      type: "spring",
                      stiffness: 320,
                      damping: 30,
                      mass: 0.8,
                    },
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
      {startFailed && !failureDismissed ? (
        <button
          type="button"
          data-realtime-attention=""
          data-testid="realtime-failure-reason"
          title={t("realtime.realtimeControl.dismiss")}
          aria-label={t("realtime.realtimeControl.dismissFailuretext", { failureText })}
          onClick={() => setFailureDismissed(true)}
          className="og-realtime-failure mr-1.5 inline-flex min-w-0 items-center gap-1 rounded-og-sm text-right text-og-xs leading-tight text-og-status-failed outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/45"
        >
          <span className="og-realtime-failure-label line-clamp-2 max-w-56">{failureText}</span>
          <XIcon className="size-3 shrink-0 opacity-70" aria-hidden />
        </button>
      ) : null}
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
            "og-realtime-primary relative inline-flex size-8 items-center justify-center outline-hidden",
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
                aria-label={t("realtime.realtimeControl.chooseVoiceModelAndOptions")}
                title={
                  modelsKnown
                    ? t("realtime.realtimeControl.voiceModelLabel", {
                        label: selectedModel.label,
                      })
                    : t("realtime.realtimeControl.chooseVoiceModelAndOptions")
                }
                disabled={props.selectionDisabled}
                className={cn(
                  // Keep the split trigger compact on desktop while preserving a
                  // full 44px mobile target independent of pointer-media support.
                  "og-realtime-model-trigger inline-flex h-11 w-11 items-center justify-center rounded-r-og-md outline-hidden sm:h-8 sm:w-6",
                  "transition-[background-color,border-color,color] duration-200 ease-og-out",
                  "focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-og-accent/45",
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
              className="og-realtime-menu flex w-72 max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] flex-col overflow-hidden"
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              {modelsKnown ? (
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
              ) : null}

              {status.phase !== "idle" &&
              // Say it once: the selected model's row already carries its reason.
              !(
                status.phase === "unavailable" &&
                pickerProvider === selectedModel.provider &&
                selectedModel.unavailableReason === status.detail
              ) ? (
                <>
                  {modelsKnown ? <DropdownMenuSeparator /> : null}
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
                  onSelect={() => void props.onRetryAudibleOutput().catch(() => undefined)}
                >
                  <Volume2Icon />
                  {t("realtime.realtimeControl.resumeAudio")}
                </DropdownMenuItem>
              ) : null}
              {retryConnection ? (
                <DropdownMenuItem onSelect={() => void props.onRetry().catch(() => undefined)}>
                  <RotateCcwIcon />
                  {t("realtime.realtimeControl.retryConnection")}
                </DropdownMenuItem>
              ) : null}
              {modeOwned && props.snapshot.status !== "lost_owner" ? (
                <DropdownMenuItem
                  variant="destructive"
                  disabled={props.snapshot.status === "stopping"}
                  onSelect={() => void props.onStop().catch(() => undefined)}
                >
                  <SquareIcon />
                  {t("realtime.realtimeControl.endVoiceConversation")}
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
  const t = useOpenGeniText();
  const [provider, setProvider] = useState<RealtimeModelProvider | null>(null);
  const [direction, setDirection] = useState<1 | -1>(1);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="realtime-voice-model-panel">
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-og-border px-2 pb-2">
        {props.leading}
        <div className="min-w-0 flex-1 text-og-menu font-medium text-og-fg">
          {t("realtime.realtimeControl.voiceModel")}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        <p className="mb-3 text-og-control text-og-fg-muted">
          {t("realtime.realtimeControl.usedWhenYouStartA")}
        </p>
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
  const t = useOpenGeniText();
  const microphone = props.kind === "microphone";
  const label = microphone
    ? props.muted
      ? t("realtime.realtimeControl.unmuteMicrophone")
      : t("realtime.realtimeControl.muteMicrophone")
    : props.muted
      ? t("realtime.realtimeControl.unmuteVoiceAudio")
      : t("realtime.realtimeControl.muteVoiceAudio");
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
        "inline-flex size-8 shrink-0 items-center justify-center rounded-og-md outline-hidden",
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
  const t = useOpenGeniText();
  const { language: languagePreference, setLanguage } = useRealtimeLanguagePreference();
  // The language page is local to the menu; leaving a provider closes it.
  const [languagePage, setLanguagePage] = useState<{
    provider: RealtimeModelProvider;
    open: boolean;
  } | null>(null);
  const changeProvider = (provider: RealtimeModelProvider | null, direction: 1 | -1) => {
    setLanguagePage(null);
    props.onProviderChange(provider, direction);
  };
  const providers = REALTIME_MODEL_PROVIDERS.filter((provider) =>
    props.models.some((model) => model.provider === provider),
  );
  const providerLanguages = props.provider
    ? props.models.find((model) => model.provider === props.provider && model.languages?.length)
        ?.languages
    : undefined;
  const languagePageOpen =
    providerLanguages !== undefined &&
    languagePage?.provider === props.provider &&
    languagePage.open;
  const direction =
    languagePage?.provider === props.provider ? (languagePage.open ? 1 : -1) : props.direction;
  const pageKey = languagePageOpen
    ? `voice-languages:${props.provider}`
    : props.provider
      ? `voice-models:${props.provider}`
      : "voice-providers";
  const appLanguage = realtimeAppLanguage(t.locale);
  const appLanguageName = appLanguage
    ? languageDisplayName(baseLanguage(appLanguage), t.locale)
    : null;
  // Without a pick of their own, the person talks in the workspace's language
  // for this provider's voice, else their app language.
  const workspaceLanguage = props.provider
    ? props.models.find(
        (model) => model.provider === props.provider && model.workspaceVoiceSettings?.language,
      )?.workspaceVoiceSettings?.language
    : undefined;
  const workspaceLanguageName = workspaceLanguage
    ? languageDisplayName(baseLanguage(workspaceLanguage), t.locale)
    : null;
  const automaticLanguageName = workspaceLanguageName ?? appLanguageName;
  const body =
    languagePageOpen && props.provider ? (
      <div data-testid="realtime-language-picker">
        <PickerBackHeader
          label={t("realtime.realtimeControl.voiceLanguage")}
          icon={<LanguagesIcon className="size-4 text-og-fg-muted" aria-hidden />}
          onBack={() => setLanguagePage({ provider: props.provider!, open: false })}
        />
        <p className="px-2.5 pb-1.5 text-og-sm text-og-fg-muted">
          {t("realtime.realtimeControl.voiceLanguageDescription")}
        </p>
        <div className="flex flex-col gap-0.5">
          <PickerNavRow
            label={t("realtime.realtimeControl.voiceLanguageAutomatic")}
            hint={
              workspaceLanguageName
                ? t("realtime.realtimeControl.voiceLanguageWorkspaceLanguage", {
                    language: workspaceLanguageName,
                  })
                : appLanguageName
                  ? t("realtime.realtimeControl.voiceLanguageAppLanguage", {
                      language: appLanguageName,
                    })
                  : undefined
            }
            disabled={props.disabled}
            active={languagePreference === null}
            showChevron={false}
            trailing={
              languagePreference === null ? (
                <CheckIcon className={MENU_CHECK_CLASS} aria-hidden />
              ) : undefined
            }
            testId="realtime-language-choice-automatic"
            onClick={() => setLanguage(null)}
          />
          {sortedLanguages(providerLanguages ?? [], t.locale).map(({ code, name, nativeName }) => {
            const selected = languagePreference === code;
            return (
              <PickerNavRow
                key={code}
                label={name}
                hint={nativeName !== name ? nativeName : undefined}
                disabled={props.disabled}
                active={selected}
                showChevron={false}
                trailing={
                  selected ? <CheckIcon className={MENU_CHECK_CLASS} aria-hidden /> : undefined
                }
                testId={`realtime-language-choice-${code}`}
                onClick={() => setLanguage(code)}
              />
            );
          })}
        </div>
      </div>
    ) : props.provider ? (
      <div data-testid="realtime-model-picker-models">
        <PickerBackHeader
          label={realtimeProviderLabel(t, props.provider)}
          icon={
            <BillingClassMark
              billingClass={REALTIME_PROVIDER_META(t)[props.provider].billingClass}
              aria-label=""
            />
          }
          onBack={() => changeProvider(null, -1)}
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
                    (model.recommended
                      ? t("realtime.realtimeControl.recommendedDescription", {
                          description: model.description,
                        })
                      : model.description)
                  }
                  disabled={props.disabled || !model.available}
                  title={model.unavailableReason ?? model.description}
                  active={selected}
                  showChevron={false}
                  trailing={
                    selected ? <CheckIcon className={MENU_CHECK_CLASS} aria-hidden /> : undefined
                  }
                  testId={`realtime-model-choice-${model.id}`}
                  onClick={() => props.onSelect(model.id)}
                />
              );
            })}
        </div>
        {providerLanguages ? (
          <div className="mt-1.5 border-t border-og-border pt-1.5">
            <PickerNavRow
              label={t("realtime.realtimeControl.voiceLanguage")}
              hint={
                languagePreference !== null
                  ? languageDisplayName(languagePreference, t.locale)
                  : automaticLanguageName
                    ? t("realtime.realtimeControl.voiceLanguageAutomaticValue", {
                        language: automaticLanguageName,
                      })
                    : t("realtime.realtimeControl.voiceLanguageAutomatic")
              }
              icon={<LanguagesIcon className="size-4 shrink-0 text-og-fg-muted" aria-hidden />}
              disabled={props.disabled}
              testId="realtime-language-row"
              onClick={() => setLanguagePage({ provider: props.provider!, open: true })}
            />
          </div>
        ) : null}
      </div>
    ) : (
      <div className="flex flex-col gap-0.5" data-testid="realtime-model-picker-providers">
        {providers.map((provider) => {
          const meta = REALTIME_PROVIDER_META(t)[provider];
          return (
            <PickerNavRow
              key={provider}
              label={realtimeProviderLabel(t, provider)}
              hint={meta.hint}
              icon={<BillingClassMark billingClass={meta.billingClass} aria-label="" />}
              active={props.selectedModel.provider === provider}
              testId={`realtime-model-provider-${meta.key}`}
              onClick={() => changeProvider(provider, 1)}
            />
          );
        })}
      </div>
    );

  return (
    <div className="relative overflow-hidden" data-testid="realtime-model-picker-menu">
      <PickerAnimatedPage pageKey={pageKey} direction={direction}>
        {body}
      </PickerAnimatedPage>
    </div>
  );
}

function baseLanguage(tag: string): string {
  return tag.split(/[-_]/)[0] ?? tag;
}

function languageDisplayName(code: string, locale: string | undefined): string {
  try {
    return (
      new Intl.DisplayNames(locale ? [locale] : undefined, { type: "language" }).of(code) ?? code
    );
  } catch {
    return code;
  }
}

function sortedLanguages(
  codes: readonly string[],
  locale: string | undefined,
): { code: string; name: string; nativeName: string }[] {
  return codes
    .map((code) => ({
      code,
      name: languageDisplayName(code, locale),
      nativeName: languageDisplayName(code, code),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, locale));
}

function RealtimeDiagnosticsMenu({ snapshot }: { snapshot: SessionRealtimeControllerSnapshot }) {
  const t = useOpenGeniText();
  const bridge = snapshot.bridge;
  const rows = [
    ["controller", snapshot.status],
    ["microphone", snapshot.microphone],
    [t("realtime.realtimeControl.microphoneMuted"), String(snapshot.inputMuted)],
    ["audio", snapshot.audibleOutput],
    [t("realtime.realtimeControl.audioMuted"), String(snapshot.outputMuted)],
    ["generation", String(snapshot.connectionGeneration)],
    [t("realtime.realtimeControl.reconnectAttempt"), String(snapshot.reconnectAttempt)],
    ["mode", snapshot.mode?.state ?? "none"],
    [
      t("realtime.realtimeControl.modeVersion"),
      snapshot.mode ? String(snapshot.mode.version) : "—",
    ],
    [
      t("realtime.realtimeControl.connectionEpoch"),
      snapshot.mode ? String(snapshot.mode.connectionEpoch) : "—",
    ],
    [
      t("realtime.realtimeControl.providerStarted"),
      bridge ? String(bridge.providerStarted) : "false",
    ],
    [t("realtime.realtimeControl.providerSpeaking"), bridge ? String(bridge.speaking) : "false"],
    ["delegation", bridge?.activeDelegationId ? "active" : "none"],
    [
      t("realtime.realtimeControl.pendingDurableEvents"),
      bridge ? String(bridge.pendingInbound) : "0",
    ],
    [t("realtime.realtimeControl.pendingBytes"), bridge ? String(bridge.pendingInboundBytes) : "0"],
    [t("realtime.realtimeControl.clientAck"), bridge?.clientAckThroughSequence?.toString() ?? "—"],
    [
      t("realtime.realtimeControl.ignoredProviderEvents"),
      bridge ? String(bridge.ignoredEventCount) : "0",
    ],
    [t("realtime.realtimeControl.lastIgnoredEvent"), bridge?.lastIgnoredEventType ?? "none"],
    [t("realtime.realtimeControl.bridgeError"), bridge?.lastError ?? "none"],
    ["diagnostic", snapshot.diagnostic?.kind ?? "none"],
  ] as const;

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="text-og-fg-muted">
          {t("realtime.realtimeControl.realtimeDiagnostics")}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-80 w-72 overflow-y-auto">
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
  | "checking"
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
  t: OpenGeniText,
  snapshot: SessionRealtimeControllerSnapshot,
  modelAvailable: boolean,
  canStart: boolean,
  admissionBlocker: string | null,
  unavailableCode: string | null = null,
  loadState: RealtimeLoadState = "ready",
  microphone: MicrophoneAccess = "unknown",
): { phase: RealtimeVisualPhase; label: string; detail: string } {
  if (snapshot.audibleOutput === "blocked" && !snapshot.outputMuted) {
    return {
      phase: "blocked",
      label: t("realtime.realtimeControl.audioOutputBlocked"),
      detail: t("realtime.realtimeControl.resumeAudioToHearThe"),
    };
  }
  switch (snapshot.status) {
    case "starting":
      return {
        phase: "connecting",
        label: t("realtime.realtimeControl.connecting"),
        detail: t("realtime.realtimeControl.preparingYourMicrophoneAndLive"),
      };
    case "active":
      return snapshot.bridge?.speaking
        ? {
            phase: "speaking",
            label: t("realtime.realtimeControl.speaking"),
            detail: t("realtime.realtimeControl.interruptNaturallyWheneverYouWant"),
          }
        : {
            phase: "listening",
            label: t("realtime.realtimeControl.listening"),
            detail: t("realtime.realtimeControl.voiceAndTypedMessagesShare"),
          };
    case "stopping":
      return {
        phase: "stopping",
        label: t("realtime.realtimeControl.endingVoice"),
        detail: t("realtime.realtimeControl.savingTheRemainingConversationContext"),
      };
    case "recovering":
      return {
        phase: "reconnecting",
        label: t("realtime.realtimeControl.reconnecting"),
        detail:
          snapshot.error ?? t("realtime.realtimeControl.keepingThisVoiceConversationConnected"),
      };
    case "lost_owner":
      return {
        phase: "elsewhere",
        label: t("realtime.realtimeControl.voiceActiveElsewhere"),
        detail: t("realtime.realtimeControl.returnToTheBrowserThat"),
      };
    case "error":
      if (snapshot.refusal) {
        return {
          phase: "unavailable",
          label:
            realtimeRefusalLabel(t, snapshot.refusal.code) ??
            t("realtime.realtimeControl.voiceUnavailable"),
          detail: snapshot.refusal.message,
        };
      }
      return {
        phase: "error",
        label: t("realtime.realtimeControl.voiceUnavailable"),
        detail: snapshot.error ?? t("realtime.realtimeControl.theConnectionCouldNotBe"),
      };
    case "idle":
      if (microphone !== "unknown") {
        return {
          phase: "unavailable",
          label: t("realtime.realtimeControl.voiceUnavailable"),
          detail:
            microphone === "blocked"
              ? t("realtime.realtimeControl.microphoneCantBeUsedHere")
              : t("composerTranscriptionControl.microphoneAccessIsBlockedAllow"),
        };
      }
      // Until what voice needs has loaded, a blocker may be a placeholder (the
      // model list starts as Codex Live alone); don't present it as a task.
      if (loadState === "loading" && (!modelAvailable || (!canStart && admissionBlocker))) {
        return {
          phase: "checking",
          label: t("realtime.realtimeControl.checkingVoice"),
          detail: t("realtime.realtimeControl.findingTheVoiceModelsYou"),
        };
      }
      if (loadState === "failed" && !modelAvailable) {
        return {
          phase: "unavailable",
          label: t("realtime.realtimeControl.voiceUnavailable"),
          detail: t("realtime.realtimeControl.voiceCouldNotLoad"),
        };
      }
      if (!modelAvailable) {
        return {
          phase: "unavailable",
          label:
            realtimeRefusalLabel(t, unavailableCode) ??
            t("realtime.realtimeControl.voiceModelUnavailable"),
          detail: admissionBlocker ?? t("realtime.realtimeControl.chooseAnotherVoiceModel"),
        };
      }
      if (!canStart && admissionBlocker) {
        return {
          phase: "unavailable",
          label: t("realtime.realtimeControl.voiceUnavailable"),
          detail: admissionBlocker,
        };
      }
      return {
        phase: "idle",
        label: t("realtime.realtimeControl.startVoice"),
        detail: t("realtime.realtimeControl.talkLiveWithTheAgent"),
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
          transition={{
            duration: 1.4,
            ease: "easeOut",
            repeat: Number.POSITIVE_INFINITY,
          }}
        />
      ) : null}
      <span
        className={cn(
          "relative size-2 rounded-full",
          live
            ? "bg-og-status-running"
            : props.phase === "blocked" || props.phase === "error"
              ? "bg-og-status-waiting"
              : props.phase === "elsewhere" ||
                  props.phase === "unavailable" ||
                  props.phase === "checking"
                ? "bg-og-fg-subtle"
                : "bg-og-accent",
        )}
      />
    </span>
  );
}

function voiceButtonTone(phase: RealtimeVisualPhase): string {
  if (phase === "listening" || phase === "speaking") {
    return "border border-og-primary-border bg-og-primary text-og-primary-fg hover:bg-og-primary-hover";
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
    return "border border-l-0 border-og-primary-border bg-og-primary text-og-primary-fg hover:bg-og-primary-hover";
  }
  if (phase === "blocked" || phase === "error") {
    return "border border-l-0 border-og-status-waiting/35 bg-og-status-waiting/10 text-og-status-waiting hover:bg-og-status-waiting/15";
  }
  if (phase === "connecting" || phase === "reconnecting" || phase === "stopping") {
    return "border border-l-0 border-og-accent/35 bg-og-accent-soft text-og-accent";
  }
  return "text-og-fg-muted hover:bg-og-surface-2 hover:text-og-fg";
}

/** @deprecated Use the provider-neutral realtime names. */
export const useSessionCodexRealtime = useSessionRealtime;
/** @deprecated Use the provider-neutral realtime names. */
export const useWorkspaceRealtimeModelSelection = useRealtimeModelSelection;
/** @deprecated Use the provider-neutral realtime names. */
export const SessionCodexRealtimeControl = SessionRealtimeControl;
/** @deprecated Use the provider-neutral realtime names. */
export const CodexRealtimeControl = RealtimeVoiceControl;
