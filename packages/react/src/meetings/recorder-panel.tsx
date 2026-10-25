/**
 * The recorder on the Meetings page. Idle, it is one row: a title, whether to
 * include the other people (other apps' audio in the desktop app, a tab's audio
 * in a browser), and Start recording. Live, the same panel shows the
 * clock, a level meter per track, Pause and Stop, and where the audio is (on
 * this device, uploading, or waiting for the connection).
 */
import { useOpenGeniText, createOpenGeniText, type OpenGeniText } from "../messages/runtime";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CircleIcon,
  InfoIcon,
  MicIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  SquareIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/field";
import { Input } from "../ui/input";
import { Notice } from "../ui/notice";
import { NativeSelect } from "../ui/select-menu";
import { cn } from "../app/lib/utils";

import { formatClock } from "../recordings";
import type { MeetingRecorder } from "./recorder-context";
import { LiveTranscript, liveStatus, type LiveTranscriptLine } from "./live-transcript";
import { DETECT_LANGUAGE, meetingLanguageOptions } from "./meeting-languages";

const defaultText = createOpenGeniText();

type RecorderError = NonNullable<MeetingRecorder["error"]>;

/** What went wrong and what to do, in the browser's terms. */
export function recorderErrorText(
  error: RecorderError,
  systemAudioKind: MeetingRecorder["systemAudioKind"] = "display",
  msg: OpenGeniText = defaultText,
): { title: string; body: string } {
  if (systemAudioKind === "desktop" && error.code === "system_audio_unavailable") {
    // The desktop app's own sentence says what to do on this computer.
    return { title: msg("meetings.recorderPanel.canTRecordComputerAudio"), body: error.message };
  }
  switch (error.code) {
    case "microphone_denied":
      return {
        title: msg("meetings.recorderPanel.microphoneBlocked"),
        body:
          systemAudioKind === "desktop"
            ? msg("meetings.recorderPanel.allowThisAppToUse")
            : msg("meetings.recorderPanel.allowMicrophoneAccessForThis"),
      };
    case "microphone_unavailable":
      return {
        title: msg("meetings.recorderPanel.noMicrophoneFound"),
        body: msg("meetings.recorderPanel.connectAMicrophoneOrCheck"),
      };
    case "system_audio_not_shared":
      return {
        title: msg("meetings.recorderPanel.theTabSAudioWasn"),
        body: msg("meetings.recorderPanel.whenYourBrowserAsksWhat"),
      };
    case "system_audio_unavailable":
      return {
        title: msg("meetings.recorderPanel.canTRecordATab"),
        body: msg("meetings.recorderPanel.thisBrowserCanTShare"),
      };
    case "unsupported":
      return {
        title: msg("meetings.recorderPanel.thisBrowserCanTRecord"),
        body: msg("meetings.recorderPanel.useACurrentVersionOf"),
      };
    case "upload_failed":
      return {
        title: msg("meetings.recorderPanel.uploadStopped"),
        body: msg("meetings.recorderPanel.uploadfailurereasonTheRecordingIsSaved", {
          uploadFailureReason: uploadFailureReason(error.message, msg),
        }),
      };
    default:
      return { title: msg("meetings.recorderPanel.recordingStopped"), body: error.message };
  }
}

/** Why the server refused the audio, as a sentence; the server's own words when it's not a known case. */
export function uploadFailureReason(message: string, msg: OpenGeniText = defaultText): string {
  const text = message.trim();
  if (/not.?found|\b404\b/i.test(text)) {
    return msg("meetings.recorderPanel.theMeetingWasDeletedOr");
  }
  if (/forbidden|permission|\b403\b/i.test(text)) {
    return msg("meetings.recorderPanel.youNoLongerHavePermission");
  }
  if (/too large|\b413\b/i.test(text)) return msg("meetings.recorderPanel.aPieceOfTheAudio");
  if (!text) return msg("meetings.recorderPanel.theServerRefusedTheAudio");
  return msg("meetings.recorderPanel.theServerRefusedTheAudio2", {
    value: text.replace(/[.\s]+$/, ""),
  });
}

/** Where the audio is right now, in one short line. */
export function uploadLine(
  recorder: MeetingRecorder,
  online: boolean,
  msg: OpenGeniText = defaultText,
): string | null {
  const upload = recorder.upload;
  const capturing = recorder.state === "recording" || recorder.state === "paused";
  if (upload?.failed)
    return msg("meetings.recorderPanel.uploadFailedMessage", { message: upload.failed.message });
  if (upload?.finalized) return msg("meetings.recorderPanel.uploaded");
  if (upload?.discarded) return msg("meetings.recorderPanel.nothingWasRecordedSoNo");
  if (!online || upload?.retryingAfterError) {
    return capturing
      ? msg("meetings.recorderPanel.notUploadingNoConnectionRecording")
      : msg("meetings.recorderPanel.notUploadingNoConnectionThe");
  }
  if (recorder.state === "paused")
    return msg("meetings.recorderPanel.nothingIsRecordedWhilePaused");
  if (capturing) {
    return msg("meetings.recorderPanel.capturingwhatValue", {
      capturingWhat: capturingWhat(recorder, msg),
      value:
        recorder.systemAudioKind === "desktop"
          ? msg("meetings.recorderPanel.youCanKeepUsingOther")
          : msg("meetings.recorderPanel.youCanUseOtherPages"),
    });
  }
  if (!upload || recorder.state === "starting") return null;
  if (upload.pendingChunks === 0) return msg("meetings.recorderPanel.finishingTheUpload");
  return msg("meetings.recorderPanel.uploadingCountPiecesOfAudio", { count: upload.pendingChunks });
}

/** What this recording captures, as a sentence. */
function capturingWhat(recorder: MeetingRecorder, msg: OpenGeniText = defaultText): string {
  const sources = new Set(recorder.tracks.map((track) => track.source));
  const system = sources.has("system");
  if (!sources.has("microphone")) {
    return system
      ? recorder.systemAudioKind === "desktop"
        ? msg("meetings.recorderPanel.recordingYourComputerSAudio")
        : msg("meetings.recorderPanel.recordingTheTabSAudio")
      : msg("meetings.recorderPanel.recording");
  }
  return system
    ? recorder.systemAudioKind === "desktop"
      ? msg("meetings.recorderPanel.recordingYourMicrophoneAndComputerAudio")
      : msg("meetings.recorderPanel.recordingYourMicrophoneAndTabAudio")
    : msg("meetings.recorderPanel.recordingYourMicrophoneOnly");
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

function trackLabel(
  source: string,
  systemAudioKind: MeetingRecorder["systemAudioKind"],
  msg: OpenGeniText = defaultText,
): string {
  if (source === "microphone") return msg("meetings.recorderPanel.microphone");
  if (source === "system")
    return systemAudioKind === "desktop"
      ? msg("meetings.recorderPanel.computerAudio")
      : msg("meetings.recorderPanel.tabAudio");
  return msg("meetings.recorderPanel.audio");
}

/** Who a track's live text is from, named like its level meter. */
export function liveSpeakerName(
  recorder: Pick<MeetingRecorder, "tracks" | "systemAudioKind">,
  trackNumber: number,
  msg: OpenGeniText = defaultText,
): string {
  const source = recorder.tracks.find((track) => track.trackNumber === trackNumber)?.source;
  // The level meters' names: a microphone may pick up a whole room, so not "You".
  return trackLabel(source ?? "", recorder.systemAudioKind, msg);
}

/** The live text the recorder has heard, as lines for {@link LiveTranscript}. */
export function recorderLiveLines(recorder: Pick<MeetingRecorder, "live">): LiveTranscriptLine[] {
  return (recorder.live ?? []).flatMap((track) => track.segments);
}

/** Why live text stopped, in the recorder's terms, from the first track's reason. */
export function liveUnavailableText(
  tracks: readonly { error: { code: string; message: string } | null }[],
  msg: OpenGeniText = defaultText,
): string {
  const code = tracks.find((track) => track.error)?.error?.code;
  const reason =
    code === "quota_exceeded"
      ? msg("meetings.recorderPanel.theLiveTranscriptionAccountHas")
      : code === "auth_error"
        ? msg("meetings.recorderPanel.theLiveTranscriptionProviderRefused")
        : code === "credential_unavailable"
          ? msg("meetings.recorderPanel.noLiveTranscriptionProviderIs")
          : code === "rate_limited" || code === "resource_exhausted" || code === "queue_overflow"
            ? msg("meetings.recorderPanel.theLiveTranscriptionProviderIs")
            : null;
  return msg("meetings.recorderPanel.liveTextIsnTAvailable", { value: reason ? ` ${reason}` : "" });
}

/** The meeting's name while it records, and renaming it without stopping. */
function RecordingTitle({ recorder }: { recorder: MeetingRecorder }) {
  const msg = useOpenGeniText();
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const title = recorder.title?.trim() || null;
  if (editing) {
    const save = async () => {
      const next = draft.trim();
      if (!next || next === title) {
        setEditing(false);
        return;
      }
      setSaving(true);
      try {
        await recorder.rename(next);
        setEditing(false);
      } catch (error) {
        toast.error(msg("meetings.recorderPanel.couldnTRenameThisMeeting"), {
          description: error instanceof Error ? error.message : undefined,
        });
      } finally {
        setSaving(false);
      }
    };
    return (
      <form
        className="mb-4 flex items-center gap-2 max-sm:flex-wrap"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          {msg("meetings.recorderPanel.meetingTitle")}
        </label>
        <Input
          id={inputId}
          autoFocus
          value={draft}
          maxLength={300}
          placeholder={msg("meetings.recorderPanel.nameThisMeeting")}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setEditing(false);
          }}
          className="h-9 min-w-0 flex-1 max-sm:basis-full"
        />
        <Button type="submit" size="sm" disabled={saving} className="pointer-coarse:h-11">
          {saving ? msg("meetings.recorderPanel.saving") : msg("meetings.recorderPanel.save")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={() => setEditing(false)}
          className="pointer-coarse:h-11"
        >
          {msg("meetings.recorderPanel.cancel")}
        </Button>
      </form>
    );
  }
  return (
    <div className="mb-4 flex min-w-0 items-center gap-1">
      <p
        className={cn(
          "min-w-0 truncate text-sm leading-5 font-medium",
          title ? "text-fg" : "text-fg-muted",
        )}
      >
        {title ?? msg("meetings.recorderPanel.noNameYet")}
      </p>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        onClick={() => {
          setDraft(title ?? "");
          setEditing(true);
        }}
        className="shrink-0 text-fg-label pointer-coarse:h-11"
      >
        <PencilIcon aria-hidden="true" />
        {title ? msg("meetings.recorderPanel.rename") : msg("meetings.recorderPanel.nameIt")}
      </Button>
    </div>
  );
}

function RecorderLiveTranscript({ recorder }: { recorder: MeetingRecorder }) {
  const msg = useOpenGeniText();
  const live = recorder.live;
  const lines = useMemo(() => recorderLiveLines({ live: live ?? null }), [live]);
  if (!live || live.length === 0) return null;
  const status = liveStatus(live, msg);
  if (lines.length === 0 && live.every((track) => track.state === "unavailable")) {
    // Nothing to read, so no empty box: one line says it and that nothing is lost.
    return (
      <p
        className="mt-3 flex items-start gap-2 rounded-[10px] border border-border bg-surface-2/60 px-3 py-2 text-xs leading-4.5 text-fg-label"
        aria-live="polite"
      >
        <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fg-muted" />
        {liveUnavailableText(live, msg)}
      </p>
    );
  }
  return (
    <LiveTranscript
      className="mt-4 border-t border-border pt-4"
      lines={lines}
      partials={live.map((track) => ({ trackNumber: track.trackNumber, text: track.partial }))}
      speakerName={(trackNumber) => liveSpeakerName(recorder, trackNumber, msg)}
      status={status}
      empty={
        recorder.state === "paused"
          ? msg("meetings.recorderPanel.pausedNothingIsHeardUntil")
          : msg("meetings.recorderPanel.listeningWhatSSaidShows")
      }
    />
  );
}

export function RecorderPanel({
  recorder,
  onStopped,
  liveTranscript = null,
  defaultLanguage = null,
  autoStart = null,
  externalRef = null,
  notice = null,
}: {
  /** Null while the capture code loads. */
  recorder: MeetingRecorder | null;
  /** After Stop, with the recording to open. */
  onStopped?: ((recordingId: string) => void) | undefined;
  /** Offer the live transcript preview; null when the workspace has no live model. */
  liveTranscript?: { defaultOn: boolean; usdPerHour?: number | null } | null;
  /** The workspace's meeting language; null detects it. */
  defaultLanguage?: string | null | undefined;
  /**
   * Start recording as soon as the recorder is ready, with this panel's
   * defaults, as a desktop call notification asked. `take` returns the
   * request once, so it starts one recording.
   */
  autoStart?: { pending: boolean; take: () => { title: string } | null } | null;
  /** The host's own id for what new recordings belong to, such as a project. */
  externalRef?: string | null | undefined;
  /** A short line shown before every start, such as a reminder to tell the people present. */
  notice?: ReactNode;
}) {
  const msg = useOpenGeniText();
  const titleId = useId();
  const tabAudioId = useId();
  const liveId = useId();
  const [title, setTitle] = useState("");
  const [languageChoice, setLanguage] = useState<string | null>(null);
  const language = languageChoice ?? defaultLanguage ?? DETECT_LANGUAGE;
  const desktopAudio = recorder?.systemAudioKind === "desktop";
  // In the desktop app computer audio is on unless turned off; a browser's
  // share prompt is something to opt into.
  const [tabAudioChoice, setTabAudio] = useState<boolean | null>(null);
  const tabAudio = tabAudioChoice ?? desktopAudio;
  const [liveChoice, setLiveChoice] = useState<boolean | null>(null);
  const liveOn = liveTranscript ? (liveChoice ?? liveTranscript.defaultOn) : false;
  const [errorDismissed, setErrorDismissed] = useState(false);
  const online = useOnline();
  const state = recorder?.state ?? "idle";
  const live = state === "recording" || state === "paused" || state === "stopping";

  const start = async (titleText: string = title) => {
    if (!recorder) return;
    setErrorDismissed(false);
    await recorder.start({
      ...(titleText.trim() ? { title: titleText.trim() } : {}),
      systemAudio: tabAudio,
      ...(liveOn ? { liveTranscript: true } : {}),
      ...(externalRef ? { externalRef } : {}),
      // Sent even when it's the workspace's, so this meeting keeps it.
      transcription: { language: language === DETECT_LANGUAGE ? null : language },
    });
  };
  const autoStartReady = Boolean(autoStart?.pending && recorder?.supported && state === "idle");
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (!autoStartReady) return;
    const request = autoStart?.take();
    if (!request) return;
    setTitle(request.title);
    void startRef.current(request.title);
  }, [autoStart, autoStartReady]);

  if (recorder && !recorder.supported) {
    return (
      <Notice tone="muted" title={msg("meetings.recorderPanel.thisBrowserCanTRecord")}>
        {msg("meetings.recorderPanel.useACurrentVersionOf2")}
      </Notice>
    );
  }

  if (recorder && live) {
    const paused = state === "paused";
    const stalled = uploadStalled(recorder, online);
    const recordingId = recorder.recordingId;
    const line = uploadLine(recorder, online, msg);
    return (
      <section
        aria-label={msg("meetings.recorderPanel.recording2")}
        className="rounded-[14px] border border-border bg-surface p-5 shadow-[0_1px_2px_rgb(0_0_0/0.04)] max-sm:p-4"
      >
        <RecordingTitle recorder={recorder} />
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
                  ? msg("meetings.recorderPanel.finishing")
                  : paused
                    ? msg("meetings.recorderPanel.paused")
                    : stalled
                      ? msg("meetings.recorderPanel.recordingNotUploading")
                      : msg("meetings.recorderPanel.recording2")}
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
                label={trackLabel(track.source, recorder.systemAudioKind, msg)}
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
              {paused ? msg("meetings.recorderPanel.resume") : msg("meetings.recorderPanel.pause")}
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
              {msg("meetings.recorderPanel.stop")}
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
        <RecorderLiveTranscript recorder={recorder} />
      </section>
    );
  }

  const starting = state === "starting";
  const error = recorder?.error && !errorDismissed ? recorder.error : null;
  const startHint = recorderHint(
    {
      desktopAudio,
      starting,
      tabAudio,
      systemAudioSupported: Boolean(recorder?.systemAudioSupported),
    },
    msg,
  );
  return (
    <section aria-label={msg("meetings.recorderPanel.newRecording")} className="grid gap-3">
      <form
        className="flex items-center gap-3 rounded-[14px] border border-border bg-surface p-2 pl-4 shadow-[0_1px_2px_rgb(0_0_0/0.04)] max-sm:flex-col max-sm:items-stretch max-sm:gap-2 max-sm:p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <MicIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle max-sm:hidden" />
        <label htmlFor={titleId} className="sr-only">
          {msg("meetings.recorderPanel.meetingTitle")}
        </label>
        <Input
          id={titleId}
          value={title}
          maxLength={300}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={msg("meetings.recorderPanel.nameThisMeetingOptional")}
          className="h-9 min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 max-sm:flex-none dark:bg-transparent"
          disabled={starting}
        />
        {recorder?.systemAudioSupported ? (
          <label
            htmlFor={tabAudioId}
            className="flex shrink-0 cursor-pointer items-center gap-2 text-sm leading-5 text-fg-label select-none pointer-coarse:min-h-11 max-sm:self-start"
            title={
              desktopAudio
                ? msg("meetings.recorderPanel.recordsTheOtherPeopleIn")
                : msg("meetings.recorderPanel.recordsTheOtherPeopleIn2")
            }
          >
            <Checkbox
              id={tabAudioId}
              checked={tabAudio}
              disabled={starting}
              onCheckedChange={setTabAudio}
            />
            {desktopAudio
              ? msg("meetings.recorderPanel.includeComputerAudio")
              : msg("meetings.recorderPanel.includeATabSAudio")}
          </label>
        ) : null}
        {liveTranscript ? (
          <label
            htmlFor={liveId}
            className="flex shrink-0 cursor-pointer items-center gap-2 text-sm leading-5 text-fg-label select-none pointer-coarse:min-h-11 max-sm:self-start"
            title={msg("meetings.recorderPanel.showsWhatSSaidAs")}
          >
            <Checkbox
              id={liveId}
              checked={liveOn}
              disabled={starting}
              onCheckedChange={setLiveChoice}
            />
            {msg("meetings.recorderPanel.liveTranscript")}
          </label>
        ) : null}
        <div className="w-40 shrink-0 max-sm:w-full">
          <NativeSelect
            aria-label={msg("meetings.recorderPanel.meetingLanguage")}
            options={meetingLanguageOptions(
              language,
              msg("meetings.recorderPanel.detectLanguage"),
              msg,
            )}
            value={language}
            onValueChange={setLanguage}
            disabled={starting}
          />
        </div>
        <Button
          type="submit"
          disabled={!recorder || starting}
          className="shrink-0 rounded-[10px] pointer-coarse:h-11 max-sm:w-full"
        >
          <CircleIcon aria-hidden="true" className="fill-status-failed text-status-failed" />
          {starting
            ? msg("meetings.recorderPanel.starting")
            : msg("meetings.recorderPanel.startRecording")}
        </Button>
      </form>
      {error ? (
        <Notice
          tone="failed"
          title={recorderErrorText(error, recorder?.systemAudioKind, msg).title}
          onDismiss={() => setErrorDismissed(true)}
        >
          {recorderErrorText(error, recorder?.systemAudioKind, msg).body}
        </Notice>
      ) : null}
      {notice ? <p className="px-1 text-sm leading-5 text-fg-label">{notice}</p> : null}
      <p className="px-1 text-xs leading-4.5 text-fg-muted" aria-live="polite">
        {startHint}
        {liveOn && !starting ? ` ${liveCostHint(liveTranscript?.usdPerHour ?? null, msg)}` : null}
      </p>
    </section>
  );
}

/** The live preview is billed on top of the transcript, so say so where it's switched on. */
export function liveCostHint(usdPerHour: number | null, msg: OpenGeniText = defaultText): string {
  return usdPerHour !== null
    ? msg("meetings.recorderPanel.theLiveTranscriptAddsAbout", { value: usdPerHour.toFixed(2) })
    : msg("meetings.recorderPanel.theLiveTranscriptUsesExtra");
}

function recorderHint(
  {
    desktopAudio,
    starting,
    tabAudio,
    systemAudioSupported,
  }: {
    desktopAudio: boolean;
    starting: boolean;
    tabAudio: boolean;
    systemAudioSupported: boolean;
  },
  msg: OpenGeniText = defaultText,
): string {
  return desktopAudio
    ? starting
      ? msg("meetings.recorderPanel.startingAllowTheMicrophoneAnd")
      : tabAudio
        ? msg("meetings.recorderPanel.recordsYourMicrophoneAndEverything")
        : msg("meetings.recorderPanel.microphoneOnlySoPeopleOn")
    : starting
      ? tabAudio
        ? msg("meetings.recorderPanel.startingAllowTheMicrophoneIf")
        : msg("meetings.recorderPanel.startingAllowTheMicrophoneIf2")
      : tabAudio
        ? msg("meetings.recorderPanel.yourBrowserAsksWhatTo")
        : systemAudioSupported
          ? msg("meetings.recorderPanel.recordsYourMicrophoneForA")
          : msg("meetings.recorderPanel.recordsYourMicrophoneTellEveryone");
}
