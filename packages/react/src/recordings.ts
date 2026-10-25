/**
 * Meeting recording hooks: capture in the browser with local-first upload,
 * list and read recordings, follow transcription, and name speakers.
 *
 * A separate entry so products that do not record never load capture code.
 * The headless pieces (recorder, uploader, local stores) live in
 * `@opengeni/sdk/recordings` for hosts without React.
 */
export {
  useLiveTranscript,
  useRecorder,
  useRecording,
  useRecordingModels,
  useRecordingPeople,
  useRecordings,
  useRecordingsClient,
  useTranscript,
} from "./hooks/use-recordings";
export type {
  UseLiveTranscriptOptions,
  UseLiveTranscriptResult,
  UseRecorderOptions,
  UseRecorderResult,
  UseRecordingOptions,
  UseRecordingResult,
  UseRecordingsOptions,
  UseRecordingsResult,
  UseTranscriptOptions,
  UseTranscriptResult,
} from "./hooks/use-recordings";
export type { RecordingsClientLike, RecordingsClientOverride } from "./hooks/use-recordings";
export {
  activeSegmentIndex,
  defaultMeetingTitle,
  defaultSpeakerName,
  formatClock,
  formatDuration,
  groupTranscriptTurns,
  languageName,
  meetingPhase,
  meetingStatusLabel,
  speakerColorSlots,
  speakerDisplayName,
  speakerIsNamed,
  transcriptErrorText,
  versionSummary,
} from "./recordings-model";
export type { MeetingPhase, TranscriptTurn } from "./recordings-model";
