import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  createMeetingRecorderStore,
  MeetingDefaultsView,
  MeetingDetailPage,
  MeetingsListPage,
  MeetingRecorderStoreProvider,
  type MeetingRecorder,
} from "@opengeni/react/meetings";
import type { WorkspaceRecordingSettings } from "@opengeni/contracts";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";

import { KitBlock, KitCanvas, KitSection } from "../kit";
import {
  createMeetingsFixture,
  FAILED_RECORDING_ID,
  LIVE_LINES,
  LIVE_RECORDING_ID,
} from "@opengeni/react/testing/meetings";

type View = "list" | "meeting" | "settings";
/** The fixture's 31-minute meeting still being transcribed. */
const TRANSCRIBING_RECORDING_ID = "0c1d2e3f-4a5b-4c6d-8e7f-a0b1c2d3e4f5";
type RecorderMode = "idle" | "recording" | "paused" | "offline" | "stopped" | "denied";
type LivePreview = "off" | "on" | "reconnecting" | "unavailable";
/** An earlier meeting this device still holds audio of, while the recorder is idle. */
type BackgroundUpload = "none" | "uploading" | "failed";

/**
 * The live preview as the recorder holds it: four lines heard, one still
 * being heard, and the microphone's echo of a line from the call (no
 * headphones), which the preview leaves out.
 */
function fakeLive(preview: LivePreview): MeetingRecorder["live"] {
  if (preview === "off") return null;
  const heard: (typeof LIVE_LINES)[number][] =
    preview === "unavailable"
      ? []
      : [
          ...LIVE_LINES.slice(0, 4),
          [0, 13.3, "The build went out last night, the error rate is flat."],
        ];
  return [0, 1].map((trackNumber) => ({
    trackNumber,
    state:
      preview === "unavailable"
        ? "unavailable"
        : preview === "reconnecting" && trackNumber === 1
          ? "reconnecting"
          : "live",
    partial: preview === "on" && trackNumber === 1 ? "Only the review on the schema" : "",
    segments: heard
      .map(([track, seconds, text], index) => ({
        trackNumber: track,
        segmentNumber: index,
        startMilliseconds: seconds * 1000,
        endMilliseconds: seconds * 1000 + 3500,
        text,
      }))
      .filter((segment) => segment.trackNumber === trackNumber),
    error:
      preview === "unavailable"
        ? { code: "credential_unavailable", message: "No speech provider key" }
        : null,
  }));
}

function fakeRecorder(
  mode: RecorderMode,
  startedAt: number,
  audio: "desktop" | "display",
  preview: LivePreview = "off",
  background: BackgroundUpload = "none",
): MeetingRecorder {
  const live = mode === "recording" || mode === "paused" || mode === "offline";
  // Just stopped: the last few seconds of audio are on their way, so it reads Transcribing.
  const stopped = mode === "stopped";
  const held = live || stopped;
  return {
    state: live
      ? mode === "paused"
        ? "paused"
        : "recording"
      : stopped
        ? "stopping"
        : mode === "denied"
          ? "failed"
          : "idle",
    // The fixture's meeting in progress, so Take notes opens the one being recorded.
    recordingId: held ? LIVE_RECORDING_ID : null,
    title: live ? "Platform standup" : null,
    elapsedMilliseconds: live ? Date.now() - startedAt : 0,
    tracks: held
      ? [
          {
            trackNumber: 0,
            source: "microphone",
            label: "MacBook Pro Microphone",
          },
          {
            trackNumber: 1,
            source: "system",
            label: audio === "desktop" ? "Computer audio" : "Meet tab",
          },
        ]
      : [],
    upload: held
      ? {
          recordingId: LIVE_RECORDING_ID,
          created: mode !== "offline",
          pendingChunks: mode === "offline" ? 7 : 1,
          pendingBytes: 120_000,
          uploading: mode !== "offline",
          retryingAfterError: mode === "offline" ? "Failed to fetch" : null,
          failed: null,
          finalized: false,
          discarded: false,
        }
      : null,
    error: mode === "denied" ? { code: "microphone_denied", message: "Permission denied" } : null,
    // Stopped, the recorder still holds what it heard until the transcript is ready.
    live: held ? fakeLive(preview) : null,
    supported: true,
    systemAudioSupported: true,
    systemAudioKind: audio,
    recovered: [],
    uploads:
      background === "none" || held
        ? {}
        : {
            [LIVE_RECORDING_ID]: {
              recordingId: LIVE_RECORDING_ID,
              created: true,
              pendingChunks: 3,
              pendingBytes: 360_000,
              uploading: background === "uploading",
              retryingAfterError: null,
              failed:
                background === "failed"
                  ? { code: "conflict", message: "The recording changed on the server" }
                  : null,
              finalized: false,
              discarded: false,
            },
          },
    retryUpload: () => false,
    start: async () => {},
    pause: () => {},
    resume: () => {},
    stop: async () => {},
    discard: async () => {},
    rename: async () => {},
    levels: () => {
      const t = Date.now() / 180;
      return {
        0: 0.35 + 0.3 * Math.abs(Math.sin(t)),
        1: 0.2 + 0.25 * Math.abs(Math.cos(t * 0.7)),
      };
    },
  };
}

export default function PageMeetingsSection() {
  const initial = new URLSearchParams(window.location.search);
  const [view, setView] = useState<View>(
    initial.get("view") === "meeting"
      ? "meeting"
      : initial.get("view") === "settings"
        ? "settings"
        : "list",
  );
  const [settings, setSettings] = useState<WorkspaceRecordingSettings>(
    initial.get("voices") === "off"
      ? { liveTranscript: true }
      : { voiceprints: true, liveTranscript: true },
  );
  const [mode, setMode] = useState<RecorderMode>(
    (initial.get("recorder") as RecorderMode | null) ?? "idle",
  );
  // ?live=on|reconnecting|unavailable shows the live transcript while recording.
  const [preview, setPreview] = useState<LivePreview>(
    (initial.get("live") as LivePreview | null) ?? "off",
  );
  const [data, setData] = useState<"ready" | "empty">(
    initial.get("data") === "empty" ? "empty" : "ready",
  );
  // ?models=pinned previews a deployment that pins one speech-to-text model.
  const pinned = initial.get("models") === "pinned";
  // ?models=credits: every model is charged in credits, so a refusal's fix is adding them.
  const creditsOnly = initial.get("models") === "credits";
  // ?models=subscription adds the organization's ChatGPT subscription.
  const subscription = initial.get("models") === "subscription";
  // ?failure=missing_provider_key makes the failed meeting's transcript fail
  // for a provider that isn't connected, instead of a used-up provider account.
  const failure = initial.get("failure");
  // ?elsewhere=off hides the viewer's Only me meetings from another workspace.
  const otherWorkspaces = initial.get("elsewhere") !== "off";
  // ?upload=elsewhere: the meeting in progress has no live preview, so its
  // audio is only on the device that recorded it.
  const elsewhereAudio = initial.get("upload") === "elsewhere";
  const fixture = useMemo(() => {
    const base = createMeetingsFixture({
      state: data,
      pinned,
      otherWorkspaces,
      creditsOnly,
      subscription,
    });
    if (!failure && !elsewhereAudio) return base;
    const getRecording: typeof base.client.getRecording = async (workspaceId, id) => {
      const recording = await base.client.getRecording(workspaceId, id);
      if (elsewhereAudio && id === LIVE_RECORDING_ID) {
        // No live preview: nothing here shows it is still being recorded.
        return {
          ...recording,
          tracks: recording.tracks.map((track) => ({ ...track, live: null })),
        };
      }
      return failure && recording.transcript && id === FAILED_RECORDING_ID
        ? { ...recording, transcript: { ...recording.transcript, errorCode: failure } }
        : recording;
    };
    return { ...base, client: { ...base.client, getRecording } };
  }, [data, pinned, failure, otherWorkspaces, creditsOnly, subscription, elsewhereAudio]);
  const store = useMemo(() => createMeetingRecorderStore(), []);
  const [startedAt] = useState(() => Date.now() - 754_000);
  // ?audio=desktop previews the desktop app, which records other apps' audio.
  const audio = initial.get("audio") === "desktop" ? "desktop" : "display";
  // ?upload=uploading|failed: this device still holds the meeting in
  // progress's audio, uploading it in the background or refused for good.
  const uploadParam = initial.get("upload");
  const background: BackgroundUpload =
    uploadParam === "uploading" || uploadParam === "failed" ? uploadParam : "none";
  useEffect(() => {
    store.set(fakeRecorder(mode, startedAt, audio, preview, background));
    if (mode !== "recording") return;
    const timer = window.setInterval(
      () => store.set(fakeRecorder(mode, startedAt, audio, preview, background)),
      250,
    );
    return () => window.clearInterval(timer);
  }, [mode, startedAt, store, audio, preview, background]);
  // ?open=live opens the meeting in progress: recorded here while the recorder
  // records, or elsewhere while it is idle. ?open=failed opens the one whose
  // transcript failed, ?open=transcribing the long one still transcribing.
  const [openId, setOpenId] = useState(
    initial.get("open") === "live"
      ? LIVE_RECORDING_ID
      : initial.get("open") === "failed"
        ? FAILED_RECORDING_ID
        : initial.get("open") === "transcribing"
          ? TRANSCRIBING_RECORDING_ID
          : fixture.readyId,
  );

  return (
    <KitSection sectionKey="page-meetings">
      <KitBlock
        title="Meetings"
        description="The production Meetings pages over an in-memory recordings API. Open a meeting, switch Summary, Transcript and Notepad, name a speaker, change a turn's speaker or correct its words, or ask about it."
      >
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <SegmentedControl
            size="sm"
            aria-label="Page"
            value={view}
            onValueChange={(value) => setView(value as View)}
            options={[
              { value: "list", label: "List" },
              { value: "meeting", label: "Meeting" },
              { value: "settings", label: "Settings" },
            ]}
          />
          <SegmentedControl
            size="sm"
            aria-label="Recorder"
            value={mode}
            onValueChange={(value) => setMode(value as RecorderMode)}
            options={[
              { value: "idle", label: "Idle" },
              { value: "recording", label: "Recording" },
              { value: "paused", label: "Paused" },
              { value: "offline", label: "Offline" },
              { value: "stopped", label: "Stopped" },
              { value: "denied", label: "Mic blocked" },
            ]}
          />
          <SegmentedControl
            size="sm"
            aria-label="Live transcript"
            value={preview}
            onValueChange={(value) => setPreview(value as LivePreview)}
            options={[
              { value: "off", label: "No live text" },
              { value: "on", label: "Live text" },
              { value: "reconnecting", label: "Reconnecting" },
              { value: "unavailable", label: "Unavailable" },
            ]}
          />
          <SegmentedControl
            size="sm"
            aria-label="Data"
            value={data}
            onValueChange={(value) => setData(value as "ready" | "empty")}
            options={[
              { value: "ready", label: "6 meetings" },
              { value: "empty", label: "Empty" },
            ]}
          />
        </div>
        <MeetingRecorderStoreProvider value={store}>
          <KitCanvas className="min-h-[760px]" padding={view !== "meeting"}>
            {view === "settings" ? (
              <div className="mx-auto max-w-[720px]">
                <MeetingDefaultsView
                  workspaceId={fixture.workspaceId}
                  recordings={fixture.client}
                  settings={settings}
                  personal={false}
                  canManage
                  viewer={{ subjectId: fixture.viewerSubjectId, name: "Ingrid Solberg" }}
                  onConnectModels={() => {}}
                  onSave={async (next) => {
                    setSettings(next);
                    return true;
                  }}
                />
              </div>
            ) : view === "list" ? (
              <MeetingsListPage
                key={data}
                workspaceId={fixture.workspaceId}
                recordings={fixture.client}
                liveTranscriptDefault={settings.liveTranscript === true}
                defaultLanguage={settings.language ?? null}
                viewerName="Ingrid Solberg"
                meetingHref={(id) => `#meeting-${id}`}
                onOpen={(id) => {
                  setOpenId(id);
                  setView("meeting");
                }}
                meetingHrefIn={(workspaceId, id) => `#meeting-${workspaceId}-${id}`}
                onOpenIn={() => {}}
              />
            ) : (
              <MeetingDetailPage
                key={openId}
                workspaceId={fixture.workspaceId}
                recordingId={openId}
                viewerSubjectId={fixture.viewerSubjectId}
                viewerName="Ingrid Solberg"
                voiceRecognition={settings.voiceprints === true}
                onOpenSettings={() => setView("settings")}
                onOpenBilling={() => toast("Opens the organization's billing")}
                onConnectModels={() => toast("Opens the workspace's models")}
                recordings={fixture.client}
                onBack={() => setView("list")}
                onOpenChat={() => toast("Opens the chat that wrote the notes")}
                // The console starts a chat with the meeting attached and the question first.
                onAsk={(_recordingId, question) => {
                  toast("Starts a chat about this meeting", { description: question });
                }}
              />
            )}
          </KitCanvas>
        </MeetingRecorderStoreProvider>
      </KitBlock>
    </KitSection>
  );
}
