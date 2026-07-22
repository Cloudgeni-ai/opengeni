import { LoaderCircleIcon, MicIcon, RefreshCwIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef } from "react";

import {
  useTranscription,
  type UseTranscriptionOptions,
  type UseTranscriptionResult,
} from "../hooks/use-transcription";
import { cn } from "../lib/cn";

export type VoiceDictationControlProps = Omit<UseTranscriptionOptions, "onFocusComposer"> & {
  className?: string;
  focusComposer?: () => void;
};

type Presentation = {
  label: string;
  status: string | null;
  pressed: boolean;
  busy: boolean;
  error: boolean;
};

function presentation(result: UseTranscriptionResult, unavailable: boolean): Presentation {
  if (unavailable) {
    return {
      label: "Voice dictation unavailable",
      status: null,
      pressed: false,
      busy: false,
      error: false,
    };
  }
  const { state } = result;
  switch (state.phase) {
    case "requesting-permission":
      return {
        label: "Cancel voice dictation",
        status: "Allow microphone access…",
        pressed: false,
        busy: true,
        error: false,
      };
    case "listening":
      return {
        label: "Stop voice dictation",
        status: state.partial?.text || "Listening…",
        pressed: true,
        busy: false,
        error: false,
      };
    case "reconnecting":
      return {
        label: "Cancel voice dictation",
        status: state.retryInMs
          ? `Reconnecting in ${Math.max(1, Math.ceil(state.retryInMs / 1000))}s…`
          : "Reconnecting…",
        pressed: true,
        busy: true,
        error: false,
      };
    case "cancelling":
      return {
        label: "Cancelling voice dictation",
        status: "Cancelling…",
        pressed: false,
        busy: true,
        error: false,
      };
    case "error":
      return {
        label: "Retry voice dictation",
        status: state.error?.message ?? "Voice dictation failed. Please retry.",
        pressed: false,
        busy: false,
        error: true,
      };
    case "closed":
      return {
        label: "Start voice dictation",
        status:
          state.closedReason === "cancelled"
            ? "Dictation cancelled"
            : state.closedReason === "completed"
              ? "Dictation added"
              : null,
        pressed: false,
        busy: false,
        error: false,
      };
    case "idle":
      return {
        label: "Start voice dictation",
        status: null,
        pressed: false,
        busy: false,
        error: false,
      };
  }
}

export function VoiceDictationControl(props: VoiceDictationControlProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const focusComposerOverride = props.focusComposer;
  const focusComposer = useCallback(() => {
    if (focusComposerOverride) {
      focusComposerOverride();
      return;
    }
    buttonRef.current?.closest(".og-root")?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, [focusComposerOverride]);
  const result = useTranscription({
    provider: props.provider,
    value: props.value,
    setValue: props.setValue,
    ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
    ...(props.language ? { language: props.language } : {}),
    ...(props.diarization === undefined ? {} : { diarization: props.diarization }),
    ...(props.privacy ? { privacy: props.privacy } : {}),
    ...(props.sessionIdFactory ? { sessionIdFactory: props.sessionIdFactory } : {}),
    onFocusComposer: focusComposer,
  });
  const { cancel, start, state, supported } = result;
  const statusId = useId();
  const unavailable = props.disabled === true || !supported;
  const view = presentation(result, unavailable);
  const canCancel =
    state.phase === "requesting-permission" ||
    state.phase === "listening" ||
    state.phase === "reconnecting";

  useEffect(() => {
    if (!canCancel) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      void cancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [canCancel, cancel]);

  const onClick = () => {
    if (canCancel) {
      void cancel();
      return;
    }
    void start();
  };

  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1.5", props.className)}
      data-transcription-phase={state.phase}
    >
      <button
        ref={buttonRef}
        type="button"
        disabled={unavailable || state.phase === "cancelling"}
        onClick={onClick}
        aria-label={view.label}
        aria-pressed={view.pressed}
        aria-busy={view.busy || undefined}
        aria-describedby={view.status ? statusId : undefined}
        title={`${view.label}${canCancel ? " (Escape to cancel)" : ""}`}
        className={cn(
          "relative inline-flex size-8 shrink-0 items-center justify-center rounded-og-md pointer-coarse:size-11",
          "outline-none transition-[background-color,color,transform] duration-150",
          "focus-visible:ring-2 focus-visible:ring-og-accent/50 focus-visible:ring-offset-1 focus-visible:ring-offset-og-surface-1",
          "disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
          view.pressed
            ? "bg-og-accent/15 text-og-accent hover:bg-og-accent/25"
            : view.error
              ? "bg-og-status-failed/10 text-og-status-failed hover:bg-og-status-failed/15"
              : "text-og-fg-muted hover:bg-og-surface-2 hover:text-og-fg",
        )}
      >
        {state.phase === "requesting-permission" || state.phase === "cancelling" ? (
          <LoaderCircleIcon className="size-4 animate-og-spin motion-reduce:animate-none" />
        ) : state.phase === "reconnecting" ? (
          <RefreshCwIcon className="size-4 animate-og-spin motion-reduce:animate-none" />
        ) : state.phase === "listening" ? (
          <>
            <span className="absolute inset-1 animate-og-pulse rounded-og-sm bg-og-accent/15 motion-reduce:animate-none" />
            <SquareIcon className="relative size-3 fill-current" />
          </>
        ) : (
          <MicIcon className="size-4" />
        )}
      </button>
      {view.status ? (
        <span
          id={statusId}
          className={cn(
            "max-w-52 truncate rounded-og-sm px-1.5 py-0.5 text-og-xs",
            view.error ? "bg-og-status-failed/10 text-og-status-failed" : "text-og-fg-subtle",
          )}
          role={view.error ? "alert" : "status"}
          aria-live={view.error ? "assertive" : "polite"}
          title={view.status}
        >
          {view.status}
        </span>
      ) : null}
    </span>
  );
}
