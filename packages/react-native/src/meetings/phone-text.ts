import type { OpenGeniText } from "@opengeni/react/messages";
import type { MeetingRecorder } from "./recorder";

type RecorderError = NonNullable<MeetingRecorder["error"]>;

/** What went wrong and what to do, in the phone's terms. */
export function phoneRecorderErrorText(
  msg: OpenGeniText,
  error: RecorderError,
): { title: string; body: string } {
  switch (error.code) {
    case "microphone_denied":
      return {
        title: msg("native.meetings.phoneText.microphoneAccessIsOff"),
        body: msg("native.meetings.phoneText.turnOnTheMicrophoneInSettings"),
      };
    case "microphone_unavailable":
      return {
        title: msg("native.meetings.phoneText.theMicrophoneIsBusy"),
        body: msg("native.meetings.phoneText.anotherAppOrACall"),
      };
    case "unsupported":
      return {
        title: msg("native.meetings.phoneText.thisVersionCanTRecord"),
        body: msg("native.meetings.phoneText.updateTheAppToRecord"),
      };
    case "upload_failed":
      return {
        title: msg("meetings.recorderPanel.uploadStopped"),
        body: msg("native.meetings.phoneText.theRecordingIsSavedOnThisPhone"),
      };
    default:
      return { title: msg("meetings.recorderPanel.recordingStopped"), body: error.message };
  }
}

/** Where the audio is right now, in one short line, or null when there is nothing to say. */
export function phoneUploadLine(msg: OpenGeniText, recorder: MeetingRecorder): string | null {
  const upload = recorder.upload;
  const capturing = recorder.state === "recording" || recorder.state === "paused";
  if (upload?.failed) {
    return msg("meetings.recorderPanel.uploadFailedMessage", { message: upload.failed.message });
  }
  if (recorder.state === "paused") {
    return recorder.pauseReason === "interruption"
      ? msg("native.meetings.phoneText.pausedWhileAnotherAppUses")
      : msg("meetings.recorderPanel.nothingIsRecordedWhilePaused");
  }
  if (upload?.retryingAfterError) {
    return capturing
      ? msg("native.meetings.phoneText.noConnectionRecordingContinues")
      : msg("native.meetings.phoneText.noConnectionTheAudioStays");
  }
  if (capturing) return msg("native.meetings.phoneText.keepsRecordingWhenLocked");
  if (recorder.state === "starting") return null;
  if (upload?.discarded) return msg("meetings.recorderPanel.nothingWasRecordedSoNo");
  if (!upload || upload.finalized) return null;
  // After Stop: the audio uploaded while it recorded, so usually only its end
  // is left; after a dropped connection it can be more.
  return msg("meetings.recorderPanel.savingTheRestOfTheAudio");
}

/** The live preview is billed on top of the transcript, so say so where it's switched on. */
export function liveCostHint(msg: OpenGeniText, usdPerHour: number | null): string {
  return usdPerHour !== null
    ? msg("native.meetings.phoneText.itAddsAboutPerHour", { value: usdPerHour.toFixed(2) })
    : msg("native.meetings.phoneText.itUsesExtraTranscriptionCredit");
}

/** The live preview's status line, or null when it is streaming normally. */
export function phoneLiveStatus(
  msg: OpenGeniText,
  tracks: readonly { state: string }[],
  paused: boolean,
): string | null {
  if (paused) return msg("meetings.recorderPanel.paused");
  if (tracks.some((track) => track.state === "reconnecting")) {
    return msg("native.meetings.phoneText.reconnecting");
  }
  if (tracks.every((track) => track.state === "connecting")) {
    return msg("native.meetings.phoneText.connecting");
  }
  return null;
}

/** "Today, 14:05", "Yesterday, 09:30", "Oct 3, 16:20" or "Oct 3, 2025", in the host's locale. */
export function meetingDateLabel(msg: OpenGeniText, iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const locale = msg.locale;
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (date.getTime() >= startOfToday) return msg("time.todayAt", { time });
  if (date.getTime() >= startOfToday - dayMs) {
    return msg("time.yesterdayAt", { time });
  }
  if (date.getFullYear() === now.getFullYear()) {
    const day = date.toLocaleDateString(locale, { month: "short", day: "numeric" });
    return msg("native.meetings.phoneText.dateTime", { date: day, time });
  }
  return date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
}
