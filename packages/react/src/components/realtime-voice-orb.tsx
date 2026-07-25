import type { RealtimeVoiceUnavailableReason } from "@opengeni/sdk";
import type { RealtimeVoiceStatus } from "../hooks/use-realtime-voice";

export type RealtimeVoiceOrbProps = {
  status: RealtimeVoiceStatus;
  targetLabel: string;
  targetSessionId: string | null;
  partial?: string | undefined;
  unavailableReason?: RealtimeVoiceUnavailableReason | null | undefined;
  /** Host-owned explanation when no exact session target can be bound. */
  unavailableDetail?: string | undefined;
  errorCode?: string | null | undefined;
  onStart: () => void;
  onStop: () => void;
  onInterrupt: () => void;
  onTextFallback: () => void;
  textFallbackDisabled?: boolean | undefined;
  className?: string | undefined;
};

const activeStatuses = new Set<RealtimeVoiceStatus>([
  "connecting",
  "listening",
  "speaking",
  "executing",
  "awaiting-approval",
  "reconnecting",
]);

/** Compact persistent voice surface; the exact normal session remains visible. */
export function RealtimeVoiceOrb(props: RealtimeVoiceOrbProps) {
  const active = activeStatuses.has(props.status);
  const busy = ["authorizing", "connecting", "closing"].includes(props.status);
  const unavailable = props.status === "unavailable";
  const statusText = voiceStatusText(props.status, props.unavailableReason, props.errorCode);
  const detail = props.partial?.trim() || props.unavailableDetail?.trim() || statusText;
  const activate = () => {
    if (props.status === "speaking") props.onInterrupt();
    else if (active) props.onStop();
    else props.onStart();
  };

  return (
    <div
      data-realtime-voice-status={props.status}
      className={classNames(
        "flex min-w-0 items-center gap-2 rounded-og-xl border border-og-border bg-og-surface-1/95 p-1.5 shadow-og-sm backdrop-blur",
        props.className,
      )}
    >
      <button
        type="button"
        onClick={activate}
        disabled={busy || unavailable}
        aria-pressed={active}
        aria-label={
          props.status === "speaking"
            ? "Interrupt voice playback"
            : active
              ? "Close realtime voice"
              : `Start realtime voice for ${props.targetLabel}`
        }
        className={classNames(
          "relative inline-flex size-10 shrink-0 items-center justify-center rounded-full border transition duration-200 motion-reduce:transition-none pointer-coarse:size-11",
          active
            ? "border-og-accent/40 bg-og-accent/15 text-og-accent"
            : "border-og-border bg-og-surface-2 text-og-fg-muted hover:text-og-fg",
          (busy || unavailable) && "cursor-not-allowed opacity-60",
          props.status === "error" && "border-og-status-failed/40 text-og-status-failed",
        )}
      >
        {busy ? (
          <VoiceIcon kind="loading" className="size-4 animate-og-spin motion-reduce:animate-none" />
        ) : props.status === "speaking" ? (
          <VoiceIcon kind="waveform" className="size-4" />
        ) : props.status === "error" || unavailable ? (
          <VoiceIcon kind="alert" className="size-4" />
        ) : active ? (
          <VoiceIcon kind="stop" className="size-3 fill-current" />
        ) : (
          <VoiceIcon kind="microphone" className="size-4" />
        )}
        {active ? (
          <span className="absolute inset-[-4px] -z-10 rounded-full border border-og-accent/25 motion-safe:animate-pulse" />
        ) : null}
      </button>

      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-og-xs font-semibold text-og-fg">Voice</span>
          <span aria-hidden="true" className="text-og-xs text-og-fg-subtle">
            ·
          </span>
          <span
            className="truncate text-og-xs font-medium text-og-fg-muted"
            title={
              props.targetSessionId
                ? `${props.targetLabel} (${props.targetSessionId})`
                : props.targetLabel
            }
          >
            {props.targetLabel}
          </span>
        </div>
        <p
          className={classNames(
            "max-w-80 truncate text-og-xs text-og-fg-subtle max-sm:max-w-44",
            props.status === "error" && "text-og-status-failed",
          )}
          title={detail}
        >
          {detail}
        </p>
      </div>

      <button
        type="button"
        onClick={props.onTextFallback}
        disabled={props.textFallbackDisabled}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-og-md text-og-fg-muted hover:bg-og-surface-2 hover:text-og-fg disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-11"
        aria-label="Use text composer instead"
        title="Use text composer"
      >
        <VoiceIcon kind="text" className="size-4" />
      </button>
      <span
        className="sr-only"
        role={props.status === "error" ? "alert" : "status"}
        aria-live="polite"
      >
        Realtime voice for {props.targetLabel}
        {props.targetSessionId ? `, session ${props.targetSessionId}` : ""}: {detail}
      </span>
    </div>
  );
}

function classNames(...values: Array<string | null | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}

function VoiceIcon({
  kind,
  className,
}: {
  kind: "alert" | "loading" | "microphone" | "stop" | "text" | "waveform";
  className: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      {kind === "loading" ? (
        <>
          <path d="M21 12a9 9 0 1 1-6.2-8.6" />
          <path d="M21 3v6h-6" />
        </>
      ) : kind === "waveform" ? (
        <>
          <path d="M3 10v4M7 7v10M11 4v16M15 7v10M19 10v4" />
        </>
      ) : kind === "alert" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M 12 7v6M 12 17h.01" />
        </>
      ) : kind === "stop" ? (
        <rect x="4" y="4" width="16" height="16" rx="2" />
      ) : kind === "microphone" ? (
        <>
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10v2a7 7 0 0 0 14 0v-2M 12 19v3" />
        </>
      ) : (
        <>
          <path d="M5 18 3 21v-5a8 8 0 1 1 3 3" />
          <path d="M8 9h8M8 13h5" />
        </>
      )}
    </svg>
  );
}

function voiceStatusText(
  status: RealtimeVoiceStatus,
  reason: RealtimeVoiceUnavailableReason | null | undefined,
  errorCode: string | null | undefined,
): string {
  switch (status) {
    case "idle":
      return "Ready for a full-duplex conversation";
    case "authorizing":
      return "Checking secure voice access…";
    case "connecting":
      return "Connecting securely…";
    case "listening":
      return "Listening — speak naturally";
    case "speaking":
      return "Speaking — tap to interrupt";
    case "executing":
      return "Working in this session…";
    case "awaiting-approval":
      return "Waiting for your approval";
    case "reconnecting":
      return "Reconnecting voice…";
    case "closing":
      return "Closing voice…";
    case "closed":
      return "Voice closed — text is still available";
    case "error":
      return errorCode === "permission_denied"
        ? "Microphone permission was denied"
        : "Voice could not continue — use text or retry";
    case "unavailable":
      return reason === "codex_realtime_protocol_unverified"
        ? "Experimental Codex audio protocol is not yet verified"
        : reason === "realtime_voice_policy_unaccepted"
          ? "Workspace voice policy is not accepted"
          : reason === "feature_disabled"
            ? "Experimental voice is disabled"
            : "Realtime voice is currently unavailable";
  }
}
