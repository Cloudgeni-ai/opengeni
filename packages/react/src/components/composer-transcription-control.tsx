import type {
  ClientVoiceInputConfig,
  OpenGeniClient,
  TranscriptionAdapter,
  WorkspaceTranscriptionPolicy,
} from "@opengeni/sdk";
import {
  ClipboardPasteIcon,
  LoaderCircleIcon,
  MicIcon,
  RefreshCwIcon,
  SquareIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type MouseEvent, type ReactElement } from "react";
import { cn } from "../lib/cn";
import { useVoiceInput } from "../hooks/use-voice-input";
import type { VoiceRecordingStore } from "../voice-recording-store";
import { useChatComposer } from "./composer";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

function Tip({ tip, children }: { tip: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top">{tip}</TooltipContent>
    </Tooltip>
  );
}

export type ComposerTranscriptionMessages = {
  start: string;
  stop: string;
  cancel: string;
  retry: string;
  requestingPermission: string;
  recording: string;
  saving: string;
  transcribing: string;
  recovered: string;
  recoveredTranscript: string;
  insertRecoveredTranscript: string;
  discardRecovered: string;
  unavailableDisabled: string;
  unavailable: string;
  errorPermissionDenied: string;
  errorNotSupported: string;
  errorUnavailable: string;
  errorTooLarge: string;
  errorInvalidAudio: string;
  errorStorageUnavailable: string;
  errorRetryable: string;
  errorHandoffUncertain: string;
  errorUnknown: string;
};

const defaultMessages: ComposerTranscriptionMessages = {
  start: "Start voice input",
  stop: "Stop and transcribe",
  cancel: "Cancel recording",
  retry: "Retry voice input",
  requestingPermission: "Requesting microphone…",
  recording: "Recording. Press Escape to cancel.",
  saving: "Saving audio locally…",
  transcribing: "Transcribing…",
  recovered: "Recording recovered and saved locally.",
  recoveredTranscript: "Transcript saved locally. Check your draft before inserting.",
  insertRecoveredTranscript: "Insert saved transcript",
  discardRecovered: "Discard saved recording",
  unavailableDisabled: "Voice input is unavailable while the composer is disabled.",
  unavailable: "Voice input is unavailable for this workspace.",
  errorPermissionDenied: "Microphone permission was denied. Your draft was not changed.",
  errorNotSupported: "Voice input is not supported on this device.",
  errorUnavailable: "Voice input is not configured.",
  errorTooLarge: "Recording is too large. Try a shorter message.",
  errorInvalidAudio: "The recording could not be read. Try again.",
  errorStorageUnavailable: "Voice input stopped because audio could not be saved safely.",
  errorRetryable: "Recording is saved locally. Retry transcription when ready.",
  errorHandoffUncertain: "Transcript is saved. Check your draft before inserting it again.",
  errorUnknown: "Voice input could not start. Try again.",
};

export type ComposerTranscriptionControlProps = {
  client?: Pick<OpenGeniClient, "transcribeAudio"> | null | undefined;
  workspaceId?: string | undefined;
  capability?: ClientVoiceInputConfig | null | undefined;
  workspaceEnabled?: boolean | undefined;
  /** @deprecated Native MediaRecorder input no longer uses host adapters. */
  adapter?: TranscriptionAdapter | null | undefined;
  /** @deprecated Native MediaRecorder input no longer uses host policies. */
  policy?: WorkspaceTranscriptionPolicy | undefined;
  /** @deprecated Native input uses the server capability duration limit. */
  lifecycleTimeouts?: unknown;
  /** @deprecated Native input does not expose provider diagnostics. */
  onDiagnostic?: unknown;
  messages?: Partial<ComposerTranscriptionMessages> | undefined;
  className?: string | undefined;
  /** Test/embed seam. Production defaults to origin-scoped IndexedDB. */
  createRecordingStore?: (() => VoiceRecordingStore) | undefined;
};

const WAVEFORM_BARS = 18;
const WAVEFORM_BAR_KEYS = Array.from(
  { length: WAVEFORM_BARS },
  (_, index) => `voice-waveform-bar-${index + 1}`,
);

/** One provider-neutral microphone control for the nearest editable composer. */
export function ComposerTranscriptionControl({
  client = null,
  workspaceId = "",
  capability = null,
  workspaceEnabled = false,
  messages: overrides,
  className,
  createRecordingStore,
}: ComposerTranscriptionControlProps) {
  const composer = useChatComposer();
  const messages = { ...defaultMessages, ...overrides };
  const transcription = useVoiceInput({
    client,
    workspaceId,
    capability,
    enabled: workspaceEnabled,
    value: composer.value,
    setValue: composer.setValue,
    focusInput: composer.focusInput,
    disabled: composer.disabled,
    createRecordingStore,
  });
  const { status } = transcription;
  const active =
    status === "requesting-permission" ||
    status === "recording" ||
    status === "saving" ||
    status === "transcribing";
  const recoverable =
    transcription.hasRecoverableRecording &&
    (status === "recovered" || status === "transcript-ready" || status === "error");
  const savedTranscript = status === "transcript-ready" && transcription.savedTranscript !== null;
  const unavailableMessage = composer.disabled
    ? messages.unavailableDisabled
    : !capability?.available || !workspaceEnabled
      ? messages.unavailable
      : !transcription.available
        ? messages.errorStorageUnavailable
        : null;
  const idleLabel = unavailableMessage ?? (status === "error" ? messages.retry : messages.start);
  const errorMessage = transcription.error
    ? transcriptionErrorMessage(transcription.error, messages)
    : null;
  const announcement =
    status === "requesting-permission"
      ? messages.requestingPermission
      : status === "recording"
        ? messages.recording
        : status === "saving"
          ? messages.saving
          : status === "transcribing"
            ? messages.transcribing
            : status === "recovered"
              ? messages.recovered
              : status === "transcript-ready"
                ? messages.recoveredTranscript
                : status === "error"
                  ? (errorMessage ?? messages.errorUnknown)
                  : unavailableMessage;

  function start(event: MouseEvent<HTMLButtonElement>) {
    if (unavailableMessage) {
      event.preventDefault();
      return;
    }
    void transcription.start();
  }

  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1.5", className)}
      data-transcription-status={status}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {recoverable ? (
          <motion.span
            key="recovered"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              "inline-flex h-8 min-w-0 items-center gap-1 rounded-og-md border border-og-border/80",
              "bg-og-surface-2/70 pl-2 pr-1 pointer-coarse:h-11",
            )}
          >
            <span className="max-w-44 truncate text-og-xs text-og-fg-muted max-sm:max-w-28">
              {savedTranscript
                ? (errorMessage ?? messages.recoveredTranscript)
                : status === "error"
                  ? (errorMessage ?? messages.errorRetryable)
                  : messages.recovered}
            </span>
            <Tip tip={savedTranscript ? messages.insertRecoveredTranscript : messages.retry}>
              <button
                type="button"
                onClick={() =>
                  savedTranscript
                    ? void transcription.insertSavedTranscript()
                    : transcription.retry()
                }
                aria-label={savedTranscript ? messages.insertRecoveredTranscript : messages.retry}
                className={cn(
                  "inline-flex size-7 shrink-0 items-center justify-center rounded-og-sm",
                  "bg-og-fg text-og-bg transition-colors duration-150 motion-reduce:transition-none",
                  "hover:bg-og-fg-muted pointer-coarse:size-11",
                )}
              >
                {savedTranscript ? (
                  <ClipboardPasteIcon className="size-3.5" />
                ) : (
                  <RefreshCwIcon className="size-3.5" />
                )}
              </button>
            </Tip>
            <Tip tip={messages.discardRecovered}>
              <button
                type="button"
                onClick={() => void transcription.discard()}
                aria-label={messages.discardRecovered}
                className={cn(
                  "inline-flex size-7 shrink-0 items-center justify-center rounded-og-sm",
                  "text-og-fg-muted transition-colors duration-150 motion-reduce:transition-none",
                  "hover:bg-og-surface-3 hover:text-og-status-failed pointer-coarse:size-11",
                )}
              >
                <Trash2Icon className="size-3.5" />
              </button>
            </Tip>
          </motion.span>
        ) : active ? (
          <motion.span
            key={status === "transcribing" || status === "saving" ? "processing" : "capture"}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              "inline-flex h-8 items-center gap-1 rounded-og-md border border-og-border/80",
              "bg-og-surface-2/70 pl-2 pr-1 pointer-coarse:h-11",
            )}
          >
            {status === "requesting-permission" ? (
              <LoaderCircleIcon
                className="size-3.5 shrink-0 text-og-fg-muted animate-og-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : (
              <span className="flex items-center gap-1.5">
                {status === "recording" ? (
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full bg-og-status-failed animate-og-pulse motion-reduce:animate-none"
                  />
                ) : null}
                <VoiceWaveform
                  stream={status === "recording" ? transcription.stream : null}
                  mode={status === "recording" ? "recording" : "transcribing"}
                />
              </span>
            )}
            {status === "recording" ? (
              <>
                <Tip tip={messages.cancel}>
                  <button
                    type="button"
                    onClick={() => transcription.cancel()}
                    aria-label={messages.cancel}
                    aria-keyshortcuts="Escape"
                    className={cn(
                      "inline-flex size-7 shrink-0 items-center justify-center rounded-og-sm",
                      "text-og-fg-muted transition-colors duration-150 motion-reduce:transition-none",
                      "hover:bg-og-surface-3 hover:text-og-fg pointer-coarse:size-11",
                    )}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </Tip>
                <Tip tip={messages.stop}>
                  <button
                    type="button"
                    onClick={() => transcription.stop()}
                    aria-label={messages.stop}
                    className={cn(
                      "inline-flex size-7 shrink-0 items-center justify-center rounded-og-sm",
                      "bg-og-fg text-og-bg transition-colors duration-150 motion-reduce:transition-none",
                      "hover:bg-og-fg-muted pointer-coarse:size-11",
                    )}
                  >
                    <SquareIcon className="size-2.5 fill-current" />
                  </button>
                </Tip>
              </>
            ) : status === "transcribing" || status === "saving" ? (
              <span className="og-shimmer-text px-1.5 text-og-xs font-medium whitespace-nowrap">
                {status === "saving" ? messages.saving : messages.transcribing}
              </span>
            ) : (
              <span className="px-1.5 text-og-xs text-og-fg-muted whitespace-nowrap">
                {messages.requestingPermission}
              </span>
            )}
          </motion.span>
        ) : (
          <Tip key="idle" tip={idleLabel}>
            <motion.button
              type="button"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
              onClick={start}
              aria-label={idleLabel}
              aria-pressed={false}
              aria-disabled={unavailableMessage !== null}
              className={cn(
                "inline-flex size-8 shrink-0 items-center justify-center rounded-og-md pointer-coarse:size-11",
                "text-og-fg-muted transition-colors duration-150 motion-reduce:transition-none",
                unavailableMessage
                  ? "cursor-not-allowed opacity-45"
                  : "hover:bg-og-surface-2 hover:text-og-fg",
              )}
            >
              <MicIcon className="size-4" />
            </motion.button>
          </Tip>
        )}
      </AnimatePresence>
      {status === "error" && errorMessage && !recoverable ? (
        <Tip tip={errorMessage}>
          <span
            aria-hidden="true"
            className="max-w-40 truncate text-og-xs text-og-status-failed max-sm:max-w-24"
          >
            {errorMessage}
          </span>
        </Tip>
      ) : null}
      <span className="sr-only" role={status === "error" ? "alert" : "status"} aria-live="polite">
        {announcement}
      </span>
    </span>
  );
}

function VoiceWaveform({
  stream,
  mode,
}: {
  stream: MediaStream | null;
  mode: "recording" | "transcribing";
}) {
  const [levels, setLevels] = useState<number[]>(() => restingLevels(WAVEFORM_BARS));
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!stream || mode !== "recording") {
      setLive(false);
      setLevels(restingLevels(WAVEFORM_BARS));
      return;
    }

    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    let cancelled = false;
    let frame = 0;
    let context: AudioContext | null = null;

    try {
      context = new AudioCtx();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      const bins = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        if (cancelled) return;
        analyser.getByteFrequencyData(bins);
        const next = new Array<number>(WAVEFORM_BARS);
        const usable = Math.max(8, Math.floor(bins.length * 0.65));
        for (let i = 0; i < WAVEFORM_BARS; i++) {
          const start = Math.floor((i / WAVEFORM_BARS) * usable);
          const end = Math.max(start + 1, Math.floor(((i + 1) / WAVEFORM_BARS) * usable));
          let sum = 0;
          for (let j = start; j < end; j++) sum += bins[j] ?? 0;
          const avg = sum / (end - start) / 255;
          next[i] = Math.min(1, 0.14 + avg * 1.65);
        }
        setLevels(next);
        setLive(true);
        frame = requestAnimationFrame(tick);
      };

      void context.resume().then(() => {
        if (!cancelled) frame = requestAnimationFrame(tick);
      });
    } catch {
      setLive(false);
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      void context?.close();
    };
  }, [stream, mode]);

  return (
    <span
      aria-hidden
      data-voice-waveform={live ? "live" : "fallback"}
      className="flex h-4 w-[3.75rem] items-center justify-center gap-px"
    >
      {WAVEFORM_BAR_KEYS.map((key, index) => {
        const level = levels[index] ?? 0;
        return (
          <span
            key={key}
            className={cn(
              "w-0.5 rounded-full bg-og-fg-muted/90 origin-center",
              !live && "animate-og-waveform motion-reduce:animate-none",
              mode === "transcribing" && "opacity-45",
            )}
            style={{
              height: live ? `${Math.max(3, Math.round(level * 14))}px` : "14px",
              animationDelay: live ? undefined : `${(index % 9) * 0.07}s`,
              opacity: live ? 0.55 + level * 0.45 : undefined,
            }}
          />
        );
      })}
    </span>
  );
}

function restingLevels(count: number): number[] {
  return Array.from({ length: count }, (_, index) => 0.22 + ((index * 17) % 5) * 0.06);
}

function transcriptionErrorMessage(code: string, messages: ComposerTranscriptionMessages): string {
  switch (code) {
    case "permission_denied":
      return messages.errorPermissionDenied;
    case "not_supported":
      return messages.errorNotSupported;
    case "unavailable":
      return messages.errorUnavailable;
    case "too_large":
      return messages.errorTooLarge;
    case "invalid_audio":
      return messages.errorInvalidAudio;
    case "storage_unavailable":
      return messages.errorStorageUnavailable;
    case "network":
    case "provider":
    case "timeout":
      return messages.errorRetryable;
    case "handoff_uncertain":
      return messages.errorHandoffUncertain;
    case "unknown":
      return messages.errorUnknown;
    default:
      return messages.errorUnknown;
  }
}
