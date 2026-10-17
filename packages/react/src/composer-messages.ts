/**
 * The composer's user-facing copy, renderer-free so web and native composers
 * (and hosts translating them) share one message catalog.
 */
import type { SlashCommand } from "./commands/types";
import { formatBytes, formatRelativeTime } from "./lib/format";

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
  sendAndResumeTitle: string;
  annotationNotesRequired: string;
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
  queueCheckoutUnconfirmed?: string | undefined;
  retryDraftSync?: string | undefined;
  useOtherDraft: string;
  keepMine: string;
  savingDraft: string;
  formatBytes: (bytes: number) => string;
  formatRelativeTime: (changedAt: string) => string;
};

export const defaultChatComposerMessages: ChatComposerMessages = {
  queueCheckoutUnconfirmed: "Queued prompt edit is not confirmed. Sending is paused.",
  retryDraftSync: "Retry draft sync",
  messagePlaceholder: "Message the agent…",
  pausedPlaceholder: "Message the agent — it will wait in the queue…",
  inputLabel: "Message the agent",
  // Shortcuts live in the send button's title; the footer stays quiet unless
  // the host supplies its own hint.
  keyboardHint: "",
  slashCommandBlocked:
    "That's a slash command — press Enter in the command list to run it, or edit the line to send a message.",
  controlChangedError:
    "This workstream was paused while you were sending. Nothing was sent, and your draft is still here.",
  sendFailedError: "Sending failed — your draft is still here. Try again.",
  dropFiles: "Drop files to attach",
  attachFiles: "Attach files",
  pauseAriaLabel: "Pause this workstream",
  pauseTitle: "Pause this workstream; queued prompts and approvals are preserved",
  stopAriaLabel: "Stop",
  stopTitle: "Stop the response",
  sendMessageAriaLabel: "Send message",
  sendAndResumeAriaLabel: "Add message to queue",
  sendTitle: "Queue message (Enter); steer with Cmd/Ctrl+Enter",
  sendAndResumeTitle: "Add to queue (Enter); steer now with Cmd/Ctrl+Enter",
  annotationNotesRequired: "Add a note to each quote before sending.",
  workspacePaused: "Workspace paused",
  pausedHere: "Paused here",
  parentBlocker: "parent",
  narrowerPause: "a narrower pause",
  pausedBy: (displayName) => `Paused by ${displayName}`,
  queuedAhead: (count) =>
    `${count} waiting prompt${count === 1 ? "" : "s"}; your message joins the queue.`,
  resumingAndSending: "Sending…",
  nextMessageResumes: "Messages wait in the queue until you resume.",
  resumeThisWorkstream: "Resume this workstream",
  resumeShort: "Resume",
  hidePauseDetails: "Hide pause details",
  showPauseDetails: "Show pause details",
  pauseReasonsLabel: "Reasons this workstream is paused",
  pausedByLabel: "Paused by ",
  alsoPausedByLabel: "Also paused by ",
  resumeWorkspace: "Resume workspace",
  resumeFromSession: "Resume from this session",
  sessionCanRun: "This session will be able to run",
  stillPausedBy: (displayName) => `Still paused by ${displayName}`,
  restoredResourcesLabel: "Restored prompt resources",
  restoredFile: (fileId) => `File ${fileId.slice(0, 8)}`,
  removeRestoredResource: (index) => `Remove restored resource ${index + 1}`,
  uploading: "Uploading",
  uploadFailed: "Upload failed",
  previewAttachment: (name) => `Preview ${name}`,
  previewUnavailable: "Preview unavailable",
  attachmentPreviewLabel: "Attachment preview",
  downloadAttachment: (name) => `Download ${name}`,
  closeAttachmentPreview: "Close",
  retryAttachment: (name) => `Retry ${name}`,
  retryUpload: "Retry upload",
  removeAttachment: (name) => `Remove ${name}`,
  confirmCommand: (name) => `Confirm /${name}`,
  confirmDescription: (command) => `Run /${command.name}? ${command.description}`,
  cancel: "Cancel",
  runCommand: (name) => `Run /${name}`,
  commands: "Commands",
  slashCommandsLabel: "Slash commands",
  modelLabel: "Model",
  close: "Close",
  danger: "danger",
  draftConflict: "This draft changed in another tab. Your local draft is still here.",
  useOtherDraft: "Use other draft",
  keepMine: "Keep mine",
  // Kept for embedder message overrides / back-compat. Routine autosave is
  // silent — only draft conflicts surface under the composer.
  savingDraft: "Saving draft…",
  formatBytes,
  formatRelativeTime,
};
