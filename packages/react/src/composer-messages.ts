/**
 * The composer's user-facing copy, renderer-free so web and native composers
 * (and hosts translating them) share one message catalog.
 */
import type { SlashCommand } from "./commands/types";
import { formatBytes, formatRelativeTime } from "./lib/format";
import { type OpenGeniText } from "./messages/runtime";

export type ChatComposerMessages = {
  messagePlaceholder: string;
  pausedPlaceholder: string;
  inputLabel: string;
  keyboardHint: string;
  slashCommandBlocked: string;
  controlChangedError: string;
  sendFailedError: string;
  dropFiles: string;
  attachFiles: string;
  pauseAriaLabel: string;
  pauseTitle: string;
  /** Stop control shown while a response runs (`runControl="stop"`). */
  stopAriaLabel?: string | undefined;
  stopTitle?: string | undefined;
  sendMessageAriaLabel: string;
  sendAndResumeAriaLabel: string;
  sendTitle: string;
  /** Send tooltip while a busy Send steers (`busySend="steer"`). */
  steerSendTitle?: string | undefined;
  /**
   * The alternate action beside Send while the agent works: Steer when Send
   * queues, Queue when Send steers.
   */
  steerLabel?: string | undefined;
  steerTitle?: string | undefined;
  queueLabel?: string | undefined;
  queueTitle?: string | undefined;
  sendAndResumeTitle: string;
  annotationNotesRequired: string;
  /** Quiet notice when Up tried to recall a prompt the agent already took. */
  queuedPromptAlreadySent: string;
  workspacePaused: string;
  pausedHere: string;
  parentBlocker: string;
  narrowerPause: string;
  pausedBy: (displayName: string) => string;
  queuedAhead: (count: number) => string;
  resumingAndSending: string;
  nextMessageResumes: string;
  resumeThisWorkstream: string;
  resumeShort: string;
  hidePauseDetails: string;
  showPauseDetails: string;
  pauseReasonsLabel: string;
  pausedByLabel: string;
  alsoPausedByLabel: string;
  resumeWorkspace: string;
  resumeFromSession: string;
  sessionCanRun: string;
  stillPausedBy: (displayName: string) => string;
  restoredResourcesLabel: string;
  restoredFile: (fileId: string) => string;
  removeRestoredResource: (index: number) => string;
  uploading: string;
  uploadFailed: string;
  previewAttachment: (name: string) => string;
  previewUnavailable?: string | undefined;
  attachmentPreviewLabel: string;
  downloadAttachment: (name: string) => string;
  closeAttachmentPreview: string;
  retryAttachment: (name: string) => string;
  retryUpload: string;
  removeAttachment: (name: string) => string;
  confirmCommand: (name: string) => string;
  confirmDescription: (command: SlashCommand) => string;
  cancel: string;
  runCommand: (name: string) => string;
  commands: string;
  slashCommandsLabel: string;
  modelLabel: string;
  close: string;
  danger: string;
  draftConflict: string;
  useOtherDraft: string;
  keepMine: string;
  savingDraft: string;
  formatBytes: (bytes: number) => string;
  formatRelativeTime: (changedAt: string) => string;
};

export const defaultChatComposerMessages = (t: OpenGeniText): ChatComposerMessages => ({
  messagePlaceholder: t("composerMessages.messageTheAgent"),
  pausedPlaceholder: t("composerMessages.messageTheAgentItWill"),
  inputLabel: t("composerMessages.messageTheAgent2"),
  // Shortcuts live in the send button's title; the footer stays quiet unless
  // the host supplies its own hint.
  keyboardHint: "",
  slashCommandBlocked: t("composerMessages.thatSASlashCommand"),
  controlChangedError: t("composerMessages.thisWorkstreamWasPausedWhile"),
  sendFailedError: t("composerMessages.sendingFailedYourDraftIs"),
  dropFiles: t("composerMessages.dropFilesToAttach"),
  attachFiles: t("composerMessages.attachFiles"),
  pauseAriaLabel: t("composerMessages.pauseThisWorkstream"),
  pauseTitle: t("composerMessages.pauseThisWorkstreamQueuedPrompts"),
  stopAriaLabel: t("composerMessages.stop"),
  stopTitle: t("composerMessages.stopTheResponse"),
  sendMessageAriaLabel: t("composerMessages.sendMessage"),
  sendAndResumeAriaLabel: t("composerMessages.addMessageToQueue"),
  sendTitle: t("composerMessages.queueMessageEnterSteerWith"),
  steerSendTitle: t("composerMessages.steerMessageEnterQueueWith"),
  steerLabel: t("composerMessages.steer"),
  steerTitle: t("composerMessages.steerReadsItSoon"),
  queueLabel: t("composerMessages.queue"),
  queueTitle: t("composerMessages.queueRunsAfterCurrentWork"),
  sendAndResumeTitle: t("composerMessages.addToQueueEnterSteer"),
  annotationNotesRequired: t("composerMessages.addANoteToEach"),
  queuedPromptAlreadySent: t("composerMessages.queuedPromptAlreadySent"),
  workspacePaused: t("composerMessages.workspacePaused"),
  pausedHere: t("composerMessages.pausedHere"),
  parentBlocker: "parent",
  narrowerPause: t("composerMessages.aNarrowerPause"),
  pausedBy: (displayName) => t("composerMessages.pausedByDisplayname", { displayName }),
  queuedAhead: (count) => t("composerMessages.queuedAhead", { count }),
  resumingAndSending: t("composerMessages.sending"),
  nextMessageResumes: t("composerMessages.messagesWaitInTheQueue"),
  resumeThisWorkstream: t("composerMessages.resumeThisWorkstream"),
  resumeShort: t("composerMessages.resume"),
  hidePauseDetails: t("composerMessages.hidePauseDetails"),
  showPauseDetails: t("composerMessages.showPauseDetails"),
  pauseReasonsLabel: t("composerMessages.reasonsThisWorkstreamIsPaused"),
  pausedByLabel: `${t("composerMessages.pausedBy")} `,
  alsoPausedByLabel: `${t("composerMessages.alsoPausedBy")} `,
  resumeWorkspace: t("composerMessages.resumeWorkspace"),
  resumeFromSession: t("composerMessages.resumeFromThisSession"),
  sessionCanRun: t("composerMessages.thisSessionWillBeAble"),
  stillPausedBy: (displayName) => t("composerMessages.stillPausedByDisplayname", { displayName }),
  restoredResourcesLabel: t("composerMessages.restoredPromptResources"),
  restoredFile: (fileId) => t("composerMessages.fileSlice", { slice: fileId.slice(0, 8) }),
  removeRestoredResource: (index) =>
    t("composerMessages.removeRestoredResourceIndex", { index: index + 1 }),
  uploading: t("composerMessages.uploading"),
  uploadFailed: t("composerMessages.uploadFailed"),
  previewAttachment: (name) => t("composerMessages.previewName", { name }),
  previewUnavailable: t("composerMessages.previewUnavailable"),
  attachmentPreviewLabel: t("composerMessages.attachmentPreview"),
  downloadAttachment: (name) => t("composerMessages.downloadName", { name }),
  closeAttachmentPreview: t("composerMessages.close"),
  retryAttachment: (name) => t("composerMessages.retryName", { name }),
  retryUpload: t("composerMessages.retryUpload"),
  removeAttachment: (name) => t("composerMessages.removeName", { name }),
  confirmCommand: (name) => t("composerMessages.confirmName", { name }),
  confirmDescription: (command) =>
    t("composerMessages.runNameDescription", {
      name: command.name,
      description: command.description,
    }),
  cancel: t("composerMessages.cancel"),
  runCommand: (name) => t("composerMessages.runName", { name }),
  commands: t("composerMessages.commands"),
  slashCommandsLabel: t("composerMessages.slashCommands"),
  modelLabel: t("composerMessages.model"),
  close: t("composerMessages.close"),
  danger: "danger",
  draftConflict: t("composerMessages.thisDraftChangedInAnother"),
  useOtherDraft: t("composerMessages.useOtherDraft"),
  keepMine: t("composerMessages.keepMine"),
  // Kept for embedder message overrides / back-compat. Routine autosave is
  // silent — only draft conflicts surface under the composer.
  savingDraft: t("composerMessages.savingDraft"),
  formatBytes,
  formatRelativeTime: (changedAt: string) => formatRelativeTime(t, changedAt),
});
