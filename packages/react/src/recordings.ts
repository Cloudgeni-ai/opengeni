/**
 * Meeting recording hooks: capture in the browser with local-first upload,
 * list and read recordings, follow transcription, and name speakers.
 *
 * A separate entry so products that do not record never load capture code.
 * The headless pieces (recorder, uploader, local stores) live in
 * `@opengeni/sdk/recordings` for hosts without React.
 */
export {
  useRecorder,
  useRecording,
  useRecordingModels,
  useRecordingPeople,
  useRecordings,
  useTranscript,
} from "./hooks/use-recordings";
export type {
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
