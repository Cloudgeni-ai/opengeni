import type {
  TranscriptionAdapter,
  TranscriptionTargetSelection,
  WorkspaceTranscriptionPolicy,
} from "@opengeni/sdk";
import { LoaderCircleIcon, MicIcon, RotateCwIcon, SquareIcon } from "lucide-react";
import { type MouseEvent } from "react";
import { cn } from "../lib/cn";
import { useTranscription } from "../hooks/use-transcription";
import { useChatComposer } from "./composer";

export type ComposerTranscriptionMessages = {
  start: string;
  stop: string;
  retry: string;
  requestingPermission: string;
  listening: string;
  reconnecting: string;
  cancelling: string;
  unavailableDisabled: string;
  unavailableAdapter: string;
  unavailablePolicy: string;
};

const defaultMessages: ComposerTranscriptionMessages = {
  start: "Start voice input",
  stop: "Stop voice input",
  retry: "Retry voice input",
  requestingPermission: "Requesting microphone permission…",
  listening: "Listening… Press Escape to cancel.",
  reconnecting: "Reconnecting voice input…",
  cancelling: "Cancelling voice input…",
  unavailableDisabled: "Voice input is unavailable while the composer is disabled.",
  unavailableAdapter: "Voice input needs an approved transcription adapter.",
  unavailablePolicy: "Enable and accept transcription in Workspace settings.",
};

export type ComposerTranscriptionControlProps = {
  adapter: TranscriptionAdapter | null;
  policy: WorkspaceTranscriptionPolicy;
  selection?: TranscriptionTargetSelection | undefined;
  messages?: Partial<ComposerTranscriptionMessages> | undefined;
  className?: string | undefined;
};

/** One provider-neutral microphone control for the nearest editable composer. */
export function ComposerTranscriptionControl({
  adapter,
  policy,
  selection,
  messages: overrides,
  className,
}: ComposerTranscriptionControlProps) {
  const composer = useChatComposer();
  const messages = { ...defaultMessages, ...overrides };
  const transcription = useTranscription({
    adapter,
    policy,
    ...(selection ? { selection } : {}),
    value: composer.value,
    setValue: composer.setValue,
    focusInput: composer.focusInput,
    disabled: composer.disabled,
  });
  const status = transcription.state.status;
  const active =
    status === "requesting-permission" ||
    status === "listening" ||
    status === "reconnecting" ||
    status === "cancelling";
  const unavailableMessage =
    transcription.unavailableReason === "composer_disabled"
      ? messages.unavailableDisabled
      : transcription.unavailableReason === "adapter_missing"
        ? messages.unavailableAdapter
        : transcription.unavailableReason
          ? messages.unavailablePolicy
          : null;
  const label = unavailableMessage
    ? unavailableMessage
    : status === "error"
      ? messages.retry
      : active
        ? messages.stop
        : messages.start;
  const announcement =
    transcription.state.partial ||
    (status === "requesting-permission"
      ? messages.requestingPermission
      : status === "listening"
        ? messages.listening
        : status === "reconnecting"
          ? (transcription.state.error?.message ?? messages.reconnecting)
          : status === "cancelling"
            ? messages.cancelling
            : status === "error"
              ? (transcription.state.error?.message ?? messages.retry)
              : unavailableMessage);

  function activate(event: MouseEvent<HTMLButtonElement>) {
    if (unavailableMessage || status === "cancelling") {
      event.preventDefault();
      return;
    }
    if (active) void transcription.cancel();
    else void transcription.start();
  }

  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1.5", className)}
      data-transcription-status={status}
    >
      <button
        type="button"
        onClick={activate}
        aria-label={label}
        aria-pressed={active}
        aria-disabled={unavailableMessage !== null || status === "cancelling"}
        aria-keyshortcuts={active ? "Escape" : undefined}
        title={label}
        className={cn(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-og-md pointer-coarse:size-11",
          "text-og-fg-muted transition-colors duration-150 motion-reduce:transition-none",
          unavailableMessage
            ? "cursor-not-allowed opacity-45"
            : status === "cancelling"
              ? "cursor-not-allowed"
              : "hover:bg-og-surface-2 hover:text-og-fg",
          status === "listening" && "bg-og-status-failed/10 text-og-status-failed",
        )}
      >
        {status === "requesting-permission" || status === "cancelling" ? (
          <LoaderCircleIcon className="size-4 animate-og-spin motion-reduce:animate-none" />
        ) : status === "reconnecting" ? (
          <RotateCwIcon className="size-4 animate-og-spin motion-reduce:animate-none" />
        ) : active ? (
          <SquareIcon className="size-3.5 fill-current" />
        ) : (
          <MicIcon className="size-4" />
        )}
      </button>
      {announcement && (active || status === "error") ? (
        <span
          aria-hidden="true"
          title={announcement}
          className={cn(
            "max-w-48 truncate text-og-xs text-og-fg-muted max-sm:max-w-28",
            status === "error" && "text-og-status-failed",
          )}
        >
          {announcement}
        </span>
      ) : null}
      <span className="sr-only" role={status === "error" ? "alert" : "status"} aria-live="polite">
        {announcement}
      </span>
    </span>
  );
}
