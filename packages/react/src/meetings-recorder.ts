/**
 * The meeting recorder alone, for mounting above a host's routes:
 * {@link MeetingRecorderProvider} and the hooks that read it. This entry
 * imports only React and the desktop bridge, and the capture code loads
 * lazily the first time it is needed, so mounting it adds almost nothing to
 * the host's startup code. The pages and components that show the recorder
 * are in `@opengeni/react/meetings` and share this same recorder.
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
