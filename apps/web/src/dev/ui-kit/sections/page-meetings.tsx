import { useEffect, useMemo, useState } from "react";

import { MeetingDetailPage } from "@/components/meetings/meeting-detail-page";
import { MeetingDefaultsView } from "@/components/meetings/meeting-settings";
import { MeetingsListPage } from "@/components/meetings/meetings-list-page";
import {
  createMeetingRecorderStore,
  MeetingRecorderStoreProvider,
  type MeetingRecorder,
} from "@/components/meetings/recorder-context";
import type { WorkspaceRecordingSettings } from "@opengeni/contracts";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";

import { KitBlock, KitCanvas, KitSection } from "../kit";
import { createMeetingsFixture } from "../pages/meetings/fixture";

type View = "list" | "meeting" | "settings";
type RecorderMode = "idle" | "recording" | "paused" | "offline" | "denied";

function fakeRecorder(
  mode: RecorderMode,
  startedAt: number,
  audio: "desktop" | "display",
): MeetingRecorder {
  const live = mode === "recording" || mode === "paused" || mode === "offline";
  return {
    state: live
      ? mode === "paused"
        ? "paused"
        : "recording"
      : mode === "denied"
        ? "failed"
        : "idle",
    recordingId: live ? "preview-live" : null,
    elapsedMilliseconds: live ? Date.now() - startedAt : 0,
    tracks: live
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
    upload: live
      ? {
          recordingId: "preview-live",
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
    supported: true,
    systemAudioSupported: true,
    systemAudioKind: audio,
    recovered: [],
    start: async () => {},
    pause: () => {},
    resume: () => {},
    stop: async () => {},
    discard: async () => {},
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
    initial.get("voices") === "off" ? {} : { voiceprints: true },
  );
  const [mode, setMode] = useState<RecorderMode>(
    (initial.get("recorder") as RecorderMode | null) ?? "idle",
  );
  const [data, setData] = useState<"ready" | "empty">(
    initial.get("data") === "empty" ? "empty" : "ready",
  );
  const fixture = useMemo(() => createMeetingsFixture({ state: data }), [data]);
  const store = useMemo(() => createMeetingRecorderStore(), []);
  const [startedAt] = useState(() => Date.now() - 754_000);
  // ?audio=desktop previews the desktop app, which records other apps' audio.
  const audio = initial.get("audio") === "desktop" ? "desktop" : "display";
  useEffect(() => {
    store.set(fakeRecorder(mode, startedAt, audio));
    if (mode !== "recording") return;
    const timer = window.setInterval(() => store.set(fakeRecorder(mode, startedAt, audio)), 250);
    return () => window.clearInterval(timer);
  }, [mode, startedAt, store, audio]);
  const [openId, setOpenId] = useState(fixture.readyId);

  return (
    <KitSection sectionKey="page-meetings">
      <KitBlock
        title="Meetings"
        description="The production Meetings pages over an in-memory recordings API. Open a meeting, name a speaker, change a turn's speaker or correct its words."
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
              { value: "denied", label: "Mic blocked" },
            ]}
          />
          <SegmentedControl
            size="sm"
            aria-label="Data"
            value={data}
            onValueChange={(value) => setData(value as "ready" | "empty")}
            options={[
              { value: "ready", label: "5 meetings" },
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
                meetingHref={(id) => `#meeting-${id}`}
                onOpen={(id) => {
                  setOpenId(id);
                  setView("meeting");
                }}
              />
            ) : (
              <MeetingDetailPage
                key={openId}
                workspaceId={fixture.workspaceId}
                recordingId={openId}
                viewerSubjectId={fixture.viewerSubjectId}
                voiceRecognition={settings.voiceprints === true}
                recordings={fixture.client}
                onBack={() => setView("list")}
              />
            )}
          </KitCanvas>
        </MeetingRecorderStoreProvider>
      </KitBlock>
    </KitSection>
  );
}
