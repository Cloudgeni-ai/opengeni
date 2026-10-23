import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useOpenGeniText, type OpenGeniText } from "@opengeni/react/messages";

/**
 * Every user-visible string the native session surfaces draw themselves (the
 * composer, question card and approval strip keep their shared web catalogs).
 * The defaults come from the shared Opengeni message catalog (`native.*` keys),
 * so the host's `OpenGeniMessagesProvider` translates them. Hosts can still
 * override entries with `NativeTimelineMessagesProvider` or the session
 * screen's `timelineMessages` prop.
 */
export interface NativeTimelineMessages {
  backToYourMessage: string;
  jumpToLatest: string;
  copyMessage: string;
  showMore: string;
  showLess: string;
  loadingEarlier: string;
  messageNotSent: string;
  humanInputOutcome: {
    answered: string;
    /** An agent answered (for example the parent of a sub-session); defaults to `answered`. */
    agentAnswered?: string;
    skipped: string;
    expired: string;
    cancelled: string;
  };
  /** An answered secret question: where the value was saved, never the value. */
  humanInputSecretSaved: (vaultName: string, itemName: string) => string;
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
  /** A pinned chat (its list section and row label). */
  pinned: string;
  pinFailed: (pinned: boolean) => string;
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

export const defaultNativeTimelineMessages = (t: OpenGeniText): NativeTimelineMessages => ({
  backToYourMessage: t("native.timeline.messages.backToYourMessage"),
  jumpToLatest: t("native.timeline.messages.jumpToLatest"),
  copyMessage: t("native.timeline.messages.copyMessage"),
  showMore: t("native.timeline.messages.showMore"),
  showLess: t("native.timeline.messages.showLess"),
  loadingEarlier: t("native.timeline.messages.loadingEarlierMessages"),
  messageNotSent: t("native.timeline.messages.messageNotSent"),
  humanInputOutcome: {
    answered: t("native.timeline.messages.youAnswered"),
    agentAnswered: t("native.timeline.messages.agentAnswered"),
    skipped: t("native.timeline.messages.skipped"),
    expired: t("native.timeline.messages.expired"),
    cancelled: t("native.timeline.messages.cancelled"),
  },
  humanInputSecretSaved: (vaultName, itemName) =>
    t("native.timeline.messages.savedToVaultnameItemname", { vaultName, itemName }),
  working: t("native.timeline.messages.working"),
  waiting: t("native.timeline.messages.waiting"),
  thinking: t("native.timeline.messages.thinking"),
  thought: t("native.timeline.messages.thought"),
  workedFor: t("native.timeline.messages.workedFor"),
  stillWaiting: t("native.timeline.messages.stillWaitingForAResponse"),
  longerThanUsual: t("native.timeline.messages.aLittleLongerThanUsual"),
  loadingPhrases: [],
  command: t("native.timeline.messages.command"),
  output: t("native.timeline.messages.output"),
  startupDetail: t("native.timeline.messages.includesOverlappingSandboxStartupCustom"),
  proposedKnowledge: t("native.timeline.messages.proposedKnowledge"),
  knowledgeSaveFailed: t("native.timeline.messages.knowledgeSaveFailed"),
  savedToKnowledge: t("native.timeline.messages.savedToKnowledge"),
  savedToMemory: t("native.timeline.messages.savedToMemory"),
  workerDecision: t("native.timeline.messages.workerDecision"),
  typeYourAnswer: t("native.timeline.messages.typeYourAnswer"),
  typeAValue: t("native.timeline.messages.typeAValue"),
  copyCode: t("native.timeline.messages.copyCode"),
  copyTable: t("native.timeline.messages.copyTable"),
  scrollTableHint: t("native.timeline.messages.scrollSidewaysToSeeEvery"),
  image: t("native.timeline.messages.image"),
  previewUnavailable: (name) => t("native.timeline.messages.namePreviewUnavailable", { name }),
  loadFailedTitle: t("native.timeline.messages.couldnTLoadThisSession"),
  connectionFailed: t("native.timeline.messages.connectionFailed"),
  stuckTitle: t("native.timeline.messages.stuck"),
  stuckBody: t("native.timeline.messages.thisChatCouldnTStart"),
  stuckAccessBody: t("native.timeline.messages.stuckAccessBody"),
  stuckRetry: t("native.timeline.messages.tryAgain"),
  stuckRetryFailed: t("native.timeline.messages.thatDidnTGoThrough"),
  retry: t("native.timeline.messages.retry"),
  cancel: t("native.timeline.messages.cancel"),
  save: t("native.timeline.messages.save"),
  saving: t("native.timeline.messages.saving"),
  goal: t("native.timeline.messages.goal"),
  pauseGoal: t("native.timeline.messages.pauseGoal"),
  resumeGoal: t("native.timeline.messages.resumeGoal"),
  agents: t("native.timeline.messages.agents"),
  commands: t("native.timeline.messages.commands"),
  running: t("native.timeline.messages.running"),
  stopping: t("native.timeline.messages.stopping"),
  finished: t("native.timeline.messages.finished"),
  stop: t("native.timeline.messages.stop"),
  onMachine: t("native.timeline.messages.onAMachine"),
  inSandbox: t("native.timeline.messages.inTheSandbox"),
  chatActions: t("native.timeline.messages.chatActions"),
  rename: t("native.timeline.messages.rename"),
  pin: t("native.timeline.messages.pin"),
  unpin: t("native.timeline.messages.unpin"),
  pinned: t("native.timeline.messages.pinned"),
  pinFailed: (pinned) =>
    pinned
      ? t("native.timeline.messages.couldNotPinThisChat")
      : t("native.timeline.messages.couldNotUnpinThisChat"),
  renameChat: t("native.timeline.messages.renameChat"),
  chatTitle: t("native.timeline.messages.chatTitle"),
  renameFailed: (reason) =>
    t("native.timeline.messages.couldnTRenameThisChat", {
      reason: reason ?? t("native.timeline.messages.tryAgain2"),
    }),
  sendFeedback: t("native.timeline.messages.sendFeedback"),
  sending: t("native.timeline.messages.sending"),
  steer: t("native.timeline.messages.steer"),
  steerFirstQueued: t("native.timeline.messages.steerFirstQueuedMessage"),
  queuedPrompts: t("native.timeline.messages.queuedPrompts"),
  dictate: t("native.timeline.messages.dictate"),
  cancelDictation: t("native.timeline.messages.cancelDictation"),
  transcribing: t("native.timeline.messages.transcribing"),
  recording: (elapsed) => t("native.timeline.messages.recordingElapsed", { elapsed }),
  recordingSaved: t("native.timeline.messages.yourRecordingIsSaved"),
  discard: t("native.timeline.messages.discard"),
  followUpPlaceholder: t("native.timeline.messages.sendAFollowUp"),
  startCall: t("native.timeline.messages.startACall"),
  returnToCall: t("native.timeline.messages.returnToCall"),
});

type NativeTimelineMessageOverrides = Partial<
  Omit<NativeTimelineMessages, "humanInputOutcome"> & {
    humanInputOutcome: Partial<NativeTimelineMessages["humanInputOutcome"]>;
  }
>;

const OverridesContext = createContext<NativeTimelineMessageOverrides | null>(null);

function mergeMessages<T extends NativeTimelineMessageOverrides>(
  base: T,
  overrides: NativeTimelineMessageOverrides,
): T {
  return {
    ...base,
    ...overrides,
    humanInputOutcome: { ...base.humanInputOutcome, ...overrides.humanInputOutcome },
  };
}

// Rows read these on every render: resolve each (text, overrides) pair once.
const resolved = new WeakMap<
  OpenGeniText,
  { defaults: NativeTimelineMessages; merged: WeakMap<object, NativeTimelineMessages> }
>();

function resolveMessages(
  t: OpenGeniText,
  overrides: NativeTimelineMessageOverrides | null,
): NativeTimelineMessages {
  let entry = resolved.get(t);
  if (!entry) {
    entry = { defaults: defaultNativeTimelineMessages(t), merged: new WeakMap() };
    resolved.set(t, entry);
  }
  if (!overrides) return entry.defaults;
  let merged = entry.merged.get(overrides);
  if (!merged) {
    merged = mergeMessages(entry.defaults, overrides);
    entry.merged.set(overrides, merged);
  }
  return merged;
}

/** Override any native timeline strings below this point (nested providers merge). */
export function NativeTimelineMessagesProvider({
  messages,
  children,
}: {
  messages?: Partial<NativeTimelineMessages> | undefined;
  children: ReactNode;
}) {
  const parent = useContext(OverridesContext);
  const value = useMemo(
    () => (messages ? (parent ? mergeMessages(parent, messages) : messages) : parent),
    [messages, parent],
  );
  return <OverridesContext.Provider value={value}>{children}</OverridesContext.Provider>;
}

/** The native timeline strings: catalog text below the nearest messages provider, plus overrides. */
export function useNativeTimelineMessages(): NativeTimelineMessages {
  return resolveMessages(useOpenGeniText(), useContext(OverridesContext));
}
