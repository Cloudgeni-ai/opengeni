/**
 * The app's one meeting recorder, held above the screens so a recording keeps
 * going while the person moves around the app (and, with the native module,
 * while the phone is locked or another app is in front).
 *
 * Audio is written to this phone's storage as it is captured and uploaded in
 * the background. Unsent audio is kept per signed-in account and only ever
 * uploaded with that account's credential; recordings the app could not
 * finish (killed, offline) finish the next time that account is active.
 */
import { useRecorder, type UseRecorderResult } from "@opengeni/react/recordings";
import { useNativeRecorderPlatform } from "@opengeni/react-native/recordings";
import { fontStyle, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { Stack } from "expo-router";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useAccount } from "@/account";

export type MeetingRecorder = UseRecorderResult & {
  /** Recordings whose upload finished while the app was open, newest last. */
  finished: readonly string[];
};

const MeetingRecorderContext = createContext<MeetingRecorder | null>(null);

export function MeetingRecorderProvider({ children }: { children: ReactNode }) {
  const { account, client, workspaceId } = useAccount();
  if (!account || !workspaceId) return <>{children}</>;
  // A new account is a new client and a new store: start a fresh recorder.
  return (
    <AccountRecorder
      key={account.id}
      accountId={account.id}
      client={client}
      workspaceId={workspaceId}
    >
      {children}
    </AccountRecorder>
  );
}

function AccountRecorder({
  accountId,
  client,
  workspaceId,
  children,
}: {
  accountId: string;
  client: object;
  workspaceId: string;
  children: ReactNode;
}) {
  const platform = useNativeRecorderPlatform({ storeScope: accountId });
  const [finished, setFinished] = useState<readonly string[]>([]);
  const recorder = useRecorder({
    client,
    workspaceId,
    platform,
    onFinished: (recordingId) =>
      setFinished((previous) => [...previous.filter((id) => id !== recordingId), recordingId]),
  });
  // The recorder's result is new on each of its updates, so this changes exactly then.
  const value = useMemo(() => ({ ...recorder, finished }), [recorder, finished]);
  return (
    <MeetingRecorderContext.Provider value={value}>{children}</MeetingRecorderContext.Provider>
  );
}

/** The live recorder, or null before an account and workspace are ready. */
export function useMeetingRecorder(): MeetingRecorder | null {
  return useContext(MeetingRecorderContext);
}

/**
 * Meetings belong to a workspace. Until one is chosen (a new account, or the
 * workspace list still loading) say so instead of rendering the screen.
 */
export function WorkspaceGate({
  title,
  children,
}: {
  title: string;
  children: (workspaceId: string) => ReactNode;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const { status, workspaceId } = useAccount();
  if (workspaceId) return <>{children(workspaceId)}</>;
  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerStyle: { backgroundColor: c.bg },
          headerTintColor: c.fg,
          headerShadowVisible: false,
        }}
      />
      <View style={{ flex: 1, backgroundColor: c.bg, padding: 24, alignItems: "center" }}>
        {status === "loading" ? (
          <ActivityIndicator style={{ marginTop: 24 }} color={c["fg-muted"]} />
        ) : (
          <Text
            style={{
              ...fontStyle(theme),
              fontSize: 15,
              lineHeight: 21,
              color: c["fg-muted"],
              textAlign: "center",
              marginTop: 24,
            }}
          >
            Choose a workspace to record and see its meetings.
          </Text>
        )}
      </View>
    </>
  );
}

/** True while capture holds the microphone. */
export function isCapturing(recorder: MeetingRecorder | null): boolean {
  const state = recorder?.state;
  return (
    state === "starting" || state === "recording" || state === "paused" || state === "stopping"
  );
}

type RecorderError = NonNullable<MeetingRecorder["error"]>;

/** What went wrong and what to do, in the phone's terms. */
export function phoneRecorderErrorText(error: RecorderError): { title: string; body: string } {
  switch (error.code) {
    case "microphone_denied":
      return {
        title: "Microphone access is off",
        body: "Turn on the microphone for Opengeni in Settings, then start again.",
      };
    case "microphone_unavailable":
      return {
        title: "The microphone is busy",
        body: "Another app or a call is using it. Try again when it's free.",
      };
    case "unsupported":
      return {
        title: "This build can't record",
        body: "Update the app to record meetings on this phone.",
      };
    case "upload_failed":
      return {
        title: "Upload stopped",
        body: "The recording is saved on this phone and uploads again the next time you open the app.",
      };
    default:
      return { title: "Recording stopped", body: error.message };
  }
}

/** Where the audio is right now, in one short line, or null when there is nothing to say. */
export function phoneUploadLine(recorder: MeetingRecorder): string | null {
  const upload = recorder.upload;
  const capturing = recorder.state === "recording" || recorder.state === "paused";
  if (upload?.failed) return `Upload failed: ${upload.failed.message}`;
  if (recorder.state === "paused") {
    return recorder.pauseReason === "interruption"
      ? "Paused while another app or a call uses the microphone. Recording continues by itself when it's free."
      : "Nothing is recorded while paused.";
  }
  if (upload?.retryingAfterError) {
    return capturing
      ? "No connection right now. Recording continues, and the audio stays on this phone until it uploads."
      : "No connection right now. The audio stays on this phone and uploads when you're back online.";
  }
  if (capturing) {
    return "Keeps recording when the screen is locked or you switch apps. Audio is saved on this phone as you go.";
  }
  if (recorder.state === "starting") return null;
  if (upload?.discarded) return "Nothing was recorded, so no meeting was saved.";
  if (!upload || upload.finalized) return null;
  if (upload.pendingChunks === 0) return "Finishing the upload.";
  return `Uploading ${upload.pendingChunks} ${upload.pendingChunks === 1 ? "piece" : "pieces"} of audio.`;
}

/** The live preview is billed on top of the transcript, so say so where it's switched on. */
export function liveCostHint(usdPerHour: number | null): string {
  return usdPerHour !== null
    ? `It adds about $${usdPerHour.toFixed(2)} per hour of audio.`
    : "It uses extra transcription credit.";
}

/** The live preview's status line, or null when it is streaming normally. */
export function phoneLiveStatus(
  tracks: readonly { state: string }[],
  paused: boolean,
): string | null {
  if (paused) return "Paused";
  if (tracks.some((track) => track.state === "reconnecting")) return "Reconnecting…";
  if (tracks.every((track) => track.state === "connecting")) return "Connecting…";
  return null;
}

/** "Today, 14:05", "Yesterday, 09:30", "Oct 3, 16:20" or "Oct 3, 2025". */
export function meetingDateLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (date.getTime() >= startOfToday) return `Today, ${time}`;
  if (date.getTime() >= startOfToday - day) return `Yesterday, ${time}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
