/** Backward-compatible non-artifact client surface. */
export { OpenGeniDocumentAuthorityClient as OpenGeniCoreClient } from "./document-authority-client";
export type {
  FetchLike,
  GetSessionOptions,
  OpenGeniClientOptions,
  OpenGeniRequestOptions,
  SendMessageInput,
  SteerMessageResult,
  TranscribeAudioInput,
  WorkspaceControlEventPage,
} from "./client";
export {
  OpenGeniApiContractMismatchError,
  OpenGeniApiError,
  OpenGeniSessionListCursorError,
  OpenGeniStreamError,
  isRetryableStreamError,
} from "./errors";
export { resolveWorkspaceVoiceInputEnabled } from "./transcription";
export { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "./types";
