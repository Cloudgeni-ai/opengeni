import type { OpenGeniMessageKey, OpenGeniText } from "./runtime";

/**
 * One Send, nothing to choose: the wording a person sees when Send while the
 * agent works is simply read as soon as it can (`busySend: "steer"` without
 * `offerQueue`). Each entry swaps a phrase that names the queue or Steer for
 * one that does not, with the same parameters. The states stay the same: a
 * message sent while the workstream is paused still waits, and messages that
 * others line up still show, as waiting messages.
 */
export const SINGLE_SEND_WORDING = {
  // Composer
  "composerMessages.messageTheAgentItWill": "composerMessages.singleSendPausedPlaceholder",
  "composerMessages.pauseThisWorkstreamQueuedPrompts": "composerMessages.singleSendPauseTitle",
  "composerMessages.addMessageToQueue": "composerMessages.sendMessage",
  "composerMessages.queueMessageEnterSteerWith": "composerMessages.singleSendTitle",
  "composerMessages.steerMessageEnterQueueWith": "composerMessages.singleSendBusyTitle",
  "composerMessages.addToQueueEnterSteer": "composerMessages.singleSendPausedTitle",
  "composerMessages.queuedAhead": "composerMessages.singleSendWaitingAhead",
  "composerMessages.messagesWaitInTheQueue": "composerMessages.singleSendReadOnResume",
  // Session chrome: the waiting-messages row and its actions
  "sessionChrome.queuedPromptCount": "sessionChrome.singleSendWaitingCount",
  "sessionChrome.queuedCount": "sessionChrome.singleSendWaitingShortCount",
  "sessionChrome.queuedcountQueuedNeedsAttention": "sessionChrome.singleSendWaitingNeedsAttention",
  "sessionChrome.queueNeedsAttention": "sessionChrome.singleSendWaitingMessagesNeedAttention",
  "sessionChrome.queueUnavailable": "sessionChrome.singleSendWaitingUnavailableSentence",
  "sessionChrome.queueUnavailable2": "sessionChrome.singleSendWaitingUnavailable",
  "sessionChrome.voiceRequestQueued": "sessionChrome.singleSendVoiceRequestWaiting",
  "sessionChrome.queuedcountVoiceRequestsQueued": "sessionChrome.singleSendVoiceRequestsWaiting",
  "sessionChrome.voiceHandoffQueued": "sessionChrome.singleSendVoiceHandoffWaiting",
  "sessionChrome.queuedMessagesAndActions": "sessionChrome.singleSendWaitingMessagesAndActions",
  "sessionChrome.queuedPrompts": "sessionChrome.singleSendWaitingMessages",
  "sessionChrome.queued": "sessionChrome.singleSendWaiting",
  "sessionChrome.placingInQueue": "composerMessages.sending",
  "sessionChrome.deleteThisQueuedPrompt": "sessionChrome.singleSendDeleteThisMessage",
  "sessionChrome.dismissUnconfirmedQueuedPrompt": "sessionChrome.singleSendDismissUnconfirmed",
  "sessionChrome.editQueuedPromptIndex": "sessionChrome.singleSendEditMessageIndex",
  "sessionChrome.moveQueuedPromptIndexUp": "sessionChrome.singleSendMoveMessageIndexUp",
  "sessionChrome.moveQueuedPromptIndexDown": "sessionChrome.singleSendMoveMessageIndexDown",
  "sessionChrome.removeQueuedPromptIndex": "sessionChrome.singleSendRemoveMessageIndex",
  "sessionChrome.notConfirmedCheckTheQueue": "sessionChrome.singleSendNotConfirmedCheck",
  // An instruction another agent sent, listed with incoming updates.
  "sessionChrome.steer": "sessionChrome.singleSendInstruction",
  "queuePresentationModel.yourComposerAlreadyHasA": "queuePresentationModel.singleSendReplaceDraft",
  "queuePresentationModel.theCurrentDraftWillBe": "queuePresentationModel.singleSendDraftDiscarded",
  // Native screens
  "counts.queuedPrompts": "counts.singleSendWaitingMessages",
  "native.timeline.messages.queuedPrompts": "sessionChrome.singleSendWaitingMessages",
  "native.presentation.queuedPrompts": "sessionChrome.singleSendWaitingMessages",
  "native.presentation.noQueuedPrompts": "native.presentation.singleSendNoWaitingMessages",
  "native.presentation.queued": "native.presentation.singleSendStarting",
} as const satisfies Partial<Record<OpenGeniMessageKey, OpenGeniMessageKey>>;

/**
 * The translator a single-Send surface uses: the same text, with the queue
 * and Steer phrases above swapped for their single-Send wording. Hosts that
 * translate Opengeni supply the `…singleSend…` keys like any other.
 */
export function singleSendText(t: OpenGeniText): OpenGeniText {
  const wording = SINGLE_SEND_WORDING as Partial<Record<string, string>>;
  const text = (key: string, ...params: unknown[]): string =>
    (t as unknown as (key: string, ...params: unknown[]) => string)(wording[key] ?? key, ...params);
  return Object.assign(text, { locale: t.locale }) as unknown as OpenGeniText;
}
