/** Backward-compatible non-artifact client surface. */
export { OpenGeniDocumentAuthorityClient as OpenGeniCoreClient } from "./document-authority-client";
export { OpenGeniToolCallError, OpenGeniToolsClient } from "./tools";
export type {
  OpenGeniGeneratedTools,
  OpenGeniDynamicToolNode,
  OpenGeniToolCallOptions,
  OpenGeniToolFunction,
  OpenGeniToolsFacade,
  OpenGeniWorkspaceTools,
} from "./tools";
export type {
  FetchLike,
  FetchResponse,
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
  OpenGeniSecureContextRequiredError,
  OpenGeniSessionListCursorError,
  OpenGeniStreamError,
  isRetryableStreamError,
} from "./errors";
export type { OpenGeniSecureContextRequiredReason } from "./errors";
export { resolveWorkspaceVoiceInputEnabled } from "./transcription";
export { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "./types";
