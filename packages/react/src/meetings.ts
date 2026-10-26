/**
 * Ready-made Meetings UI: the recorder, the meetings list, a meeting's page
 * with its transcript, player and speaker naming, and the workspace's
 * meeting settings. Built on the hooks in `@opengeni/react/recordings`.
 *
 * Mount {@link MeetingRecorderProvider} once above the host's routes, so a
 * recording keeps going while the person moves around. Import it from
 * `@opengeni/react/meetings-recorder` there: that entry holds only the
 * recorder, so the rest of this UI stays out of the host's startup code. The
 * pages navigate through callbacks (`onOpen`, `meetingHref`, `onBack`), so any
 * router works.
 */
export {
  createMeetingRecorderStore,
  MeetingRecorderProvider,
  MeetingRecorderStoreProvider,
  useMeetingRecorder,
  useMeetingRecorderState,
  usePendingMeetingStart,
} from "./meetings/recorder-context";
export type {
  MeetingRecorder,
  MeetingRecorderStore,
  MeetingStartRequest,
} from "./meetings/recorder-context";
export { RecorderPanel } from "./meetings/recorder-panel";
export { MeetingsListPage } from "./meetings/meetings-list-page";
export { MeetingDetailPage } from "./meetings/meeting-detail-page";
export type { MeetingDetail } from "./meetings/meeting-detail-page";
export { MeetingTranscript } from "./meetings/meeting-transcript";
export type { TranscriptActions, VoiceActions } from "./meetings/meeting-transcript";
export { MeetingPlayer } from "./meetings/meeting-player";
export type { MeetingPlayerHandle, MeetingPlayerSource } from "./meetings/meeting-player";
export { LiveTranscript } from "./meetings/live-transcript";
export type { LiveTranscriptLine } from "./meetings/live-transcript";
export { DeleteMeetingDialog } from "./meetings/delete-meeting-dialog";
export { MeetingNotes } from "./meetings/meeting-notes";
export { MeetingDefaultsView } from "./meetings/meeting-settings";
export type { MeetingSettingsViewer } from "./meetings/meeting-settings";
export { DETECT_LANGUAGE, MEETING_LANGUAGES } from "./meetings/meeting-languages";
