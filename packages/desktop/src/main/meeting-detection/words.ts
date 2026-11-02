// The words of the card that asks whether to record a call. English unless
// the app gives its own, so an app in another language passes `words` to
// `createMeetingDetection`.

export interface MeetingWords {
  /** The card's window title, for window lists and screen readers. */
  title: string;
  /** Asked when a call starts. */
  recordQuestion: string;
  /** Why it asks, for a browser. `{app}` is its name, e.g. "Google Chrome". */
  browserStarted: string;
  /** Why it asks, for a call app. `{app}` is its name, e.g. "Zoom". */
  callStarted: string;
  /** Starts recording the call. */
  record: string;
  /** Closes the question without recording. */
  notNow: string;
  /** Asked when the call being recorded ends. */
  stopQuestion: string;
  /** Why it asks. `{app}` is the call's app. */
  callEnded: string;
  /** Stops the recording. */
  stop: string;
  /** Closes the question and keeps recording. */
  keepRecording: string;
  /**
   * Said when a call started recording without asking. Added later, so an
   * app's own words may lack it and the English is shown.
   */
  recordingStarted?: string;
  /** Why it is recording. `{app}` is the call's app. */
  callRecording?: string;
  /** Closes the card and keeps recording. */
  ok?: string;
}

export const ENGLISH_MEETING_WORDS: Required<MeetingWords> = {
  title: "Meeting detected",
  recordQuestion: "Record this meeting?",
  browserStarted: "{app} is using your microphone.",
  callStarted: "A call in {app} started.",
  record: "Record",
  notNow: "Not now",
  stopQuestion: "Meeting over?",
  callEnded: "{app} stopped using your microphone. Still recording.",
  stop: "Stop recording",
  keepRecording: "Keep recording",
  recordingStarted: "Recording this call",
  callRecording: "A call in {app} started, so it's being recorded.",
  ok: "OK",
};

/** `template` with each `{name}` replaced. */
export function fillMeetingWords(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}
