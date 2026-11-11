// `@opengeni/desktop/meeting-detection`: offer to record calls in any Electron app.
//
//   const meetings = createMeetingDetection({ helperPath, appId, dataDir, reveal });
//   handleMeetingDetectionIpc({ ipcMain, detection: meetings, allow });
//   app.whenReady().then(() => meetings.start());
//   app.on("will-quit", () => meetings.stop());
//
// The page exposes the bridge with `exposeMeetingDetection()` from
// `@opengeni/desktop/preload/meeting-detection`; Opengeni's meeting recorder
// then records when the person chooses Record on the card.

export {
  MeetingDetection,
  MeetingDetectionStore,
  promptText,
  type MeetingDetectionOptions,
  type MeetingPage,
  type MeetingPrompt,
  type MeetingPromptOutcome,
  type MeetingPromptText,
  type MeetingPromptView,
  type ShownPrompt,
} from "./index";
export { ENGLISH_MEETING_WORDS, fillMeetingWords, type MeetingWords } from "./words";
export { MeetingPromptCard, MEETING_CARD_TIMEOUT_MS, type MeetingPromptCardOptions } from "./card";
export { handleMeetingDetectionIpc } from "./ipc";
export {
  createMeetingDetection,
  meetingDetectionFileLog,
  type CreateMeetingDetectionOptions,
} from "./electron";
