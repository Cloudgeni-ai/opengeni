import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * Every user-visible string the native session surfaces draw themselves (the
 * composer, question card and approval strip keep their shared web catalogs).
 * Hosts translate by overriding entries with `NativeTimelineMessagesProvider`
 * or the session screen's `timelineMessages` prop.
 */
export interface NativeTimelineMessages {
  backToYourMessage: string;
  jumpToLatest: string;
  copyMessage: string;
  showMore: string;
  showLess: string;
  loadingEarlier: string;
  messageNotSent: string;
  humanInputOutcome: { answered: string; skipped: string; expired: string; cancelled: string };
  working: string;
  waiting: string;
  thinking: string;
  thought: string;
  workedFor: string;
  stillWaiting: string;
  longerThanUsual: string;
  /**
   * The loading copy that rotates beside the orb while a reply starts. Empty
   * keeps the built-in phrases; a host's own voice replaces them, as the web
   * timeline's loading `phrases` option does.
   */
  loadingPhrases: readonly string[];
  command: string;
  output: string;
  startupDetail: string;
  proposedKnowledge: string;
  knowledgeSaveFailed: string;
  savedToKnowledge: string;
  savedToMemory: string;
  workerDecision: string;
  typeYourAnswer: string;
  typeAValue: string;
  copyCode: string;
  copyTable: string;
  scrollTableHint: string;
  image: string;
  previewUnavailable: (name: string) => string;
  loadFailedTitle: string;
  connectionFailed: string;
  /** A session whose next step the runtime could not start (an admission block). */
  stuckTitle: string;
  stuckBody: string;
  /** The block clears only once someone restores access the work needs. */
  stuckAccessBody: string;
  stuckRetry: string;
  stuckRetryFailed: string;
  retry: string;
  cancel: string;
  save: string;
  saving: string;
  goal: string;
  pauseGoal: string;
  resumeGoal: string;
  agents: string;
  commands: string;
  running: string;
  stopping: string;
  finished: string;
  stop: string;
  onMachine: string;
  inSandbox: string;
  chatActions: string;
  rename: string;
  pin: string;
  unpin: string;
  renameChat: string;
  chatTitle: string;
  renameFailed: (reason: string | null) => string;
  sendFeedback: string;
  sending: string;
  steer: string;
  steerFirstQueued: string;
  queuedPrompts: string;
  dictate: string;
  cancelDictation: string;
  transcribing: string;
  recording: (elapsed: string) => string;
  recordingSaved: string;
  discard: string;
  followUpPlaceholder: string;
  /** The composer's call button: start a voice call with the agent. */
  startCall: string;
  /** The composer's call button while this conversation is already on a call. */
  returnToCall: string;
}

export const defaultNativeTimelineMessages: NativeTimelineMessages = {
  backToYourMessage: "Back to your message",
  jumpToLatest: "Jump to latest",
  copyMessage: "Copy message",
  showMore: "Show more",
  showLess: "Show less",
  loadingEarlier: "Loading earlier messages",
  messageNotSent: "Message not sent",
  humanInputOutcome: {
    answered: "You answered",
    skipped: "Skipped",
    expired: "Expired",
    cancelled: "Cancelled",
  },
  working: "Working",
  waiting: "Waiting",
  thinking: "Thinking",
  thought: "Thought",
  workedFor: "Worked for",
  stillWaiting: "Still waiting for a response…",
  longerThanUsual: "A little longer than usual…",
  loadingPhrases: [],
  command: "Command",
  output: "Output",
  startupDetail:
    "Includes overlapping sandbox startup, custom environment setup, repository preparation, and runtime setup shown below.",
  proposedKnowledge: "Proposed knowledge",
  knowledgeSaveFailed: "Knowledge save failed",
  savedToKnowledge: "Saved to knowledge",
  savedToMemory: "Saved to memory",
  workerDecision: "Worker decision",
  typeYourAnswer: "Type your answer...",
  typeAValue: "Type a value...",
  copyCode: "Copy code",
  copyTable: "Copy table",
  scrollTableHint: "Scroll sideways to see every column",
  image: "Image",
  previewUnavailable: (name) => `${name} (preview unavailable)`,
  loadFailedTitle: "Couldn't load this session",
  connectionFailed: "Couldn't connect. Check your connection; this retries automatically.",
  stuckTitle: "Stuck",
  stuckBody:
    "This chat couldn't start its next step. Nothing is needed from you, and its work is kept. Try again to continue.",
  stuckAccessBody:
    "This chat can't continue until access it needs is restored. Its work is kept; try again once that's sorted.",
  stuckRetry: "Try again",
  stuckRetryFailed: "That didn't go through. Try again in a moment.",
  retry: "Retry",
  cancel: "Cancel",
  save: "Save",
  saving: "Saving…",
  goal: "Goal",
  pauseGoal: "Pause goal",
  resumeGoal: "Resume goal",
  agents: "Agents",
  commands: "Commands",
  running: "Running",
  stopping: "Stopping",
  finished: "Finished",
  stop: "Stop",
  onMachine: "On a machine",
  inSandbox: "In the sandbox",
  chatActions: "Chat actions",
  rename: "Rename",
  pin: "Pin",
  unpin: "Unpin",
  renameChat: "Rename chat",
  chatTitle: "Chat title",
  renameFailed: (reason) => `Couldn't rename this chat. ${reason ?? "Try again."}`,
  sendFeedback: "Send feedback",
  sending: "Sending…",
  steer: "Steer",
  steerFirstQueued: "Steer first queued message",
  queuedPrompts: "Queued prompts",
  dictate: "Dictate",
  cancelDictation: "Cancel dictation",
  transcribing: "Transcribing",
  recording: (elapsed) => `Recording, ${elapsed}`,
  recordingSaved: "Your recording is saved.",
  discard: "Discard",
  followUpPlaceholder: "Send a follow-up...",
  startCall: "Start a call",
  returnToCall: "Return to call",
};

const MessagesContext = createContext<NativeTimelineMessages>(defaultNativeTimelineMessages);

/** Override any native timeline strings below this point (nested providers merge). */
export function NativeTimelineMessagesProvider({
  messages,
  children,
}: {
  messages?: Partial<NativeTimelineMessages> | undefined;
  children: ReactNode;
}) {
  const parent = useContext(MessagesContext);
  const value = useMemo(
    () =>
      messages
        ? {
            ...parent,
            ...messages,
            humanInputOutcome: { ...parent.humanInputOutcome, ...messages.humanInputOutcome },
          }
        : parent,
    [messages, parent],
  );
  return <MessagesContext.Provider value={value}>{children}</MessagesContext.Provider>;
}

export function useNativeTimelineMessages(): NativeTimelineMessages {
  return useContext(MessagesContext);
}
