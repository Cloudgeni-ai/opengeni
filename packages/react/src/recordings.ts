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
  useRecordingNotes,
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
  UseRecordingNotesOptions,
  UseRecordingNotesResult,
  UseTranscriptOptions,
  UseTranscriptResult,
} from "./hooks/use-recordings";
export type { RecordingsClientLike, RecordingsClientOverride } from "./hooks/use-recordings";
/** Dictation is a recording too: speech kept until its text is in the draft. */
export { useVoiceInput } from "./hooks/use-voice-input";
export type {
  UseVoiceInputOptions,
  UseVoiceInputResult,
  VoiceInputRecordingsClient,
  VoiceInputStatus,
} from "./hooks/use-voice-input";
export {
  activeSegmentIndex,
  defaultMeetingTitle,
  defaultSpeakerName,
  formatClock,
  formatDuration,
  groupLiveTurns,
  groupTranscriptTurns,
  languageName,
  meetingPhase,
  meetingStatusLabel,
  speakerColorSlots,
  speakerDisplayName,
  speakerIsNamed,
  tidyLiveText,
  tidyPartialText,
  transcriptErrorText,
  versionSummary,
} from "./recordings-model";
export type {
  LiveTranscriptLine,
  LiveTranscriptTurn,
  MeetingPhase,
  TranscriptTurn,
} from "./recordings-model";
