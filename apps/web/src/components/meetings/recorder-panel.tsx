/**
 * The recorder on the Meetings page. Idle, it is one row: a title, whether to
 * include the other people (other apps' audio in the desktop app, a tab's audio
 * in a browser), and Start recording. Live, the same panel shows the
 * clock, a level meter per track, Pause and Stop, and where the audio is (on
 * this device, uploading, or waiting for the connection).
 */
import { useEffect, useId, useRef, useState } from "react";
import { CircleIcon, MicIcon, PauseIcon, PlayIcon, SquareIcon } from "lucide-react";

import { Button } from "@opengeni/react/ui/button";
import { Checkbox } from "@opengeni/react/ui/field";
import { Input } from "@opengeni/react/ui/input";
import { Notice } from "@opengeni/react/ui/notice";
import { cn } from "@opengeni/react/app/lib/utils";

import { formatClock } from "@opengeni/react/recordings";
import type { MeetingRecorder } from "./recorder-context";

type RecorderError = NonNullable<MeetingRecorder["error"]>;

/** What went wrong and what to do, in the browser's terms. */
export function recorderErrorText(
  error: RecorderError,
  systemAudioKind: MeetingRecorder["systemAudioKind"] = "display",
): { title: string; body: string } {
  if (systemAudioKind === "desktop" && error.code === "system_audio_unavailable") {
    // The desktop app's own sentence says what to do on this computer.
    return { title: "Can't record other apps' audio", body: error.message };
  }
  switch (error.code) {
    case "microphone_denied":
      return {
        title: "Microphone blocked",
        body:
          systemAudioKind === "desktop"
            ? "Allow this app to use the microphone in your computer's privacy settings, then start again."
            : "Allow microphone access for this site in your browser's address bar or settings, then start again.",
      };
    case "microphone_unavailable":
      return {
        title: "No microphone found",
        body: "Connect a microphone or check that no other app is holding it, then start again.",
      };
    case "system_audio_not_shared":
      return {
        title: "The tab's audio wasn't shared",
        body: "When your browser asks what to share, pick the meeting tab and turn on Share tab audio. Or record without it.",
      };
    case "system_audio_unavailable":
      return {
        title: "Can't record a tab's audio here",
        body: "This browser can't share a tab's audio. Record with the microphone only, or use Chrome or Edge on a computer.",
      };
    case "unsupported":
      return {
        title: "This browser can't record",
        body: "Use a current version of Chrome, Edge, Safari or Firefox.",
      };
    case "upload_failed":
      return {
        title: "Upload stopped",
        body: "The recording is saved on this device. It uploads again when you reopen Meetings.",
      };
    default:
      return { title: "Recording stopped", body: error.message };
  }
}

/** Where the audio is right now, in one short line. */
export function uploadLine(recorder: MeetingRecorder, online: boolean): string | null {
  const upload = recorder.upload;
  const capturing = recorder.state === "recording" || recorder.state === "paused";
  if (upload?.failed) return `Upload failed: ${upload.failed.message}`;
  if (upload?.finalized) return "Uploaded";
  if (upload?.discarded) return "Nothing was recorded, so no meeting was saved.";
  if (!online || upload?.retryingAfterError) {
    return capturing
      ? "Not uploading: no connection. Recording continues, and the audio is kept on this device until it uploads."
      : "Not uploading: no connection. The audio is kept on this device and uploads when you're back.";
  }
  if (recorder.state === "paused") return "Nothing is recorded while paused.";
  if (capturing) {
    return "You can use other pages while it records. The audio is saved as you go, so a dropped connection loses nothing.";
  }
  if (!upload || recorder.state === "starting") return null;
  if (upload.pendingChunks === 0) return "Finishing the upload.";
  return `Uploading ${upload.pendingChunks} ${upload.pendingChunks === 1 ? "piece" : "pieces"} of audio.`;
}

/** True while audio is waiting on this device because the connection is down. */
export function uploadStalled(recorder: MeetingRecorder, online: boolean): boolean {
  const upload = recorder.upload;
  if (upload?.failed || upload?.finalized || upload?.discarded) return false;
  return !online || Boolean(upload?.retryingAfterError);
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

/** A level bar fed from the analyser every frame, without re-rendering React. */
function LevelMeter({
  recorder,
  trackNumber,
  label,
  paused,
}: {
  recorder: MeetingRecorder;
  trackNumber: number;
  label: string;
  paused: boolean;
}) {
  const barRef = useRef<HTMLSpanElement>(null);
  const levels = recorder.levels;
  useEffect(() => {
    let frame = 0;
    let smoothed = 0;
    const tick = () => {
      const level = paused ? 0 : (levels()[trackNumber] ?? 0);
      // Fast attack, slow release, so speech reads as steady movement.
      smoothed = level > smoothed ? level : smoothed * 0.88 + level * 0.12;
      if (barRef.current) barRef.current.style.transform = `scaleX(${Math.max(0.02, smoothed)})`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [levels, trackNumber, paused]);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-24 shrink-0 truncate text-xs leading-4 text-fg-muted">{label}</span>
      <span
        aria-hidden="true"
        className="relative h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-surface-2"
      >
        <span
          ref={barRef}
          className="absolute inset-0 origin-left rounded-full bg-status-idle transition-transform duration-75 motion-reduce:transition-none"
          style={{ transform: "scaleX(0.02)" }}
        />
      </span>
    </div>
  );
}

function trackLabel(source: string, systemAudioKind: MeetingRecorder["systemAudioKind"]): string {
  if (source === "microphone") return "Microphone";
  if (source === "system") return systemAudioKind === "desktop" ? "Other apps" : "Tab audio";
  return "Audio";
}

export function RecorderPanel({
  recorder,
  onStopped,
}: {
  /** Null while the capture code loads. */
  recorder: MeetingRecorder | null;
  /** After Stop, with the recording to open. */
  onStopped?: ((recordingId: string) => void) | undefined;
}) {
  const titleId = useId();
  const tabAudioId = useId();
  const [title, setTitle] = useState("");
  const desktopAudio = recorder?.systemAudioKind === "desktop";
  // In the desktop app other apps' audio is on unless turned off; a browser's
  // share prompt is something to opt into.
  const [tabAudioChoice, setTabAudio] = useState<boolean | null>(null);
  const tabAudio = tabAudioChoice ?? desktopAudio;
  const [errorDismissed, setErrorDismissed] = useState(false);
  const online = useOnline();
  const state = recorder?.state ?? "idle";
  const live = state === "recording" || state === "paused" || state === "stopping";

  if (recorder && !recorder.supported) {
    return (
      <Notice tone="muted" title="This browser can't record">
        Use a current version of Chrome, Edge, Safari or Firefox to record meetings.
      </Notice>
    );
  }

  if (recorder && live) {
    const paused = state === "paused";
    const stalled = uploadStalled(recorder, online);
    const recordingId = recorder.recordingId;
    const line = uploadLine(recorder, online);
    return (
      <section
        aria-label="Recording"
        className="rounded-[14px] border border-border bg-surface p-5 shadow-[0_1px_2px_rgb(0_0_0/0.04)] max-sm:p-4"
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="relative flex size-3 shrink-0" aria-hidden="true">
              {!paused ? (
                <span
                  className={cn(
                    "absolute inset-0 animate-ping rounded-full motion-reduce:animate-none",
                    stalled ? "bg-status-waiting/60" : "bg-status-failed/60",
                  )}
                />
              ) : null}
              <span
                className={cn(
                  "relative size-3 rounded-full",
                  paused ? "bg-fg-subtle" : stalled ? "bg-status-waiting" : "bg-status-failed",
                )}
              />
            </span>
            <div className="min-w-0">
              <p className="text-sm leading-5 font-medium text-fg">
                {state === "stopping"
                  ? "Finishing"
                  : paused
                    ? "Paused"
                    : stalled
                      ? "Recording · not uploading"
                      : "Recording"}
              </p>
              <p
                className="text-2xl leading-8 font-semibold tracking-[-0.5px] text-fg tabular-nums"
                role="timer"
                aria-live="off"
              >
                {formatClock(recorder.elapsedMilliseconds)}
              </p>
            </div>
          </div>
          <div className="grid min-w-48 flex-1 gap-2">
            {recorder.tracks.map((track) => (
              <LevelMeter
                key={track.trackNumber}
                recorder={recorder}
                trackNumber={track.trackNumber}
                label={trackLabel(track.source, recorder.systemAudioKind)}
                paused={paused}
              />
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-2 max-sm:w-full">
            <Button
              type="button"
              variant="outline"
              disabled={state === "stopping"}
              onClick={() => (paused ? recorder.resume() : recorder.pause())}
              className="rounded-[10px] pointer-coarse:h-11 max-sm:flex-1"
            >
              {paused ? <PlayIcon aria-hidden="true" /> : <PauseIcon aria-hidden="true" />}
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button
              type="button"
              disabled={state === "stopping"}
              onClick={() => {
                void recorder.stop().then(() => {
                  if (recordingId) onStopped?.(recordingId);
                });
              }}
              className="rounded-[10px] pointer-coarse:h-11 max-sm:flex-1"
            >
              <SquareIcon aria-hidden="true" className="fill-current" />
              Stop
            </Button>
          </div>
        </div>
        {line ? (
          <p
            className={cn(
              "mt-3 text-xs leading-4.5",
              stalled ? "font-medium text-fg-label" : "text-fg-muted",
            )}
            aria-live="polite"
          >
            {line}
          </p>
        ) : null}
      </section>
    );
  }

  const starting = state === "starting";
  const error = recorder?.error && !errorDismissed ? recorder.error : null;
  const start = async () => {
    if (!recorder) return;
    setErrorDismissed(false);
    await recorder.start({
      ...(title.trim() ? { title: title.trim() } : {}),
      systemAudio: tabAudio,
    });
  };
  return (
    <section aria-label="New recording" className="grid gap-3">
      <form
        className="flex items-center gap-3 rounded-[14px] border border-border bg-surface p-2 pl-4 shadow-[0_1px_2px_rgb(0_0_0/0.04)] max-sm:flex-col max-sm:items-stretch max-sm:gap-2 max-sm:p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <MicIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle max-sm:hidden" />
        <label htmlFor={titleId} className="sr-only">
          Meeting title
        </label>
        <Input
          id={titleId}
          value={title}
          maxLength={300}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Name this meeting (optional)"
          className="h-9 min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 max-sm:flex-none dark:bg-transparent"
          disabled={starting}
        />
        {recorder?.systemAudioSupported ? (
          <label
            htmlFor={tabAudioId}
            className="flex shrink-0 cursor-pointer items-center gap-2 text-sm leading-5 text-fg-label select-none pointer-coarse:min-h-11 max-sm:self-start"
            title={
              desktopAudio
                ? "Records the other people in a call in Zoom, Teams, Meet or any other app"
                : "Records the other people in a browser call, such as Google Meet or Teams on the web"
            }
          >
            <Checkbox
              id={tabAudioId}
              checked={tabAudio}
              disabled={starting}
              onCheckedChange={setTabAudio}
            />
            {desktopAudio ? "Include other apps' audio" : "Include a tab's audio"}
          </label>
        ) : null}
        <Button
          type="submit"
          disabled={!recorder || starting}
          className="shrink-0 rounded-[10px] pointer-coarse:h-11 max-sm:w-full"
        >
          <CircleIcon aria-hidden="true" className="fill-status-failed text-status-failed" />
          {starting ? "Starting" : "Start recording"}
        </Button>
      </form>
      {!error ? (
        <p className="px-1 text-xs leading-4.5 text-fg-muted" aria-live="polite">
          {desktopAudio
            ? starting
              ? "Starting. Allow the microphone, and recording other apps' audio, if your computer asks."
              : tabAudio
                ? "Records your microphone and what other apps play, so everyone in a call is heard. Let people know you're recording."
                : "Records your microphone only. Include other apps' audio to hear everyone in a call. Let people know you're recording."
            : starting
              ? tabAudio
                ? "Starting. Allow the microphone if your browser asks, then pick the meeting tab and turn on Share tab audio."
                : "Starting. Allow the microphone if your browser asks."
              : tabAudio
                ? "Your browser asks what to share next. Pick the meeting tab and turn on Share tab audio."
                : recorder?.systemAudioSupported
                  ? "Records your microphone. For a call in another browser tab, such as Meet, Teams or Zoom on the web, include its audio to hear everyone. Let people know you're recording."
                  : "Records your microphone. Let people know you're recording."}
        </p>
      ) : null}
      {error ? (
        <Notice
          tone="failed"
          title={recorderErrorText(error, recorder?.systemAudioKind).title}
          onDismiss={() => setErrorDismissed(true)}
        >
          {recorderErrorText(error, recorder?.systemAudioKind).body}
        </Notice>
      ) : null}
    </section>
  );
}
