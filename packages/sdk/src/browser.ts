/** Browser-console client. Optional SDK surfaces must not enter this eager graph. */
export { OpenGeniClient as OpenGeniBrowserClient } from "./client";
export {
  OpenGeniToolCallError,
  OpenGeniToolReapprovalRequiredError,
  OpenGeniToolsClient,
} from "./tools";
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
