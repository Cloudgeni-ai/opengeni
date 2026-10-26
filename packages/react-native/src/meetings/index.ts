// Meetings on a phone: one recorder held above the screens, the meetings list
// with the recorder on top, and one meeting's transcript. Wrap them in an
// `OpenGeniProvider` with the client, workspace and host text.
export {
  isCapturing,
  MeetingRecorderProvider,
  useMeetingRecorder,
  type MeetingRecorder,
  type MeetingRecorderProviderProps,
} from "./recorder";
export { MeetingsList, type MeetingsListProps } from "./meetings-list";
export {
  useMeetingView,
  type MeetingAction,
  type MeetingActionId,
  type MeetingView,
  type UseMeetingViewOptions,
} from "./meeting-view";
export {
  liveCostHint,
  meetingDateLabel,
  phoneLiveStatus,
  phoneRecorderErrorText,
  phoneUploadLine,
} from "./phone-text";
