/**
 * The new-session composer's server-authoritative draft (text, model, options,
 * project, attachments), shared by the web app and native apps so a draft
 * started on one device continues on another.
 */
export {
  isNewSessionDraftConflict,
  useNewSessionDraft,
  type AcknowledgeConsumedNewSessionDraftResult,
  type FlushedNewSessionDraft,
  type NewSessionDraftEditable,
  type UseNewSessionDraftOptions,
  type UseNewSessionDraftResult,
} from "./hooks/use-new-session-draft";
export {
  isTransientServiceFailure,
  OPENGENI_UPDATING_NOTICE,
  retryTransient,
  TRANSIENT_RECONNECT_INTERVAL_MS,
  TRANSIENT_RETRY_DELAYS_MS,
  type RetryTransientOptions,
} from "./lib/transient-retry";
