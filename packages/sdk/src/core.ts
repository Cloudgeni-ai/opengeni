export type {
  ModelDecisionRequest,
  ModelDecisionResponse,
  DecisionQuestion,
  DecisionResult,
  DecisionUsage,
  DecisionAnswer,
  DecisionAnswerFor,
  DecisionRefusal,
  DecisionPredicateQuestion,
  DecisionChoiceQuestion,
  DecisionScoreQuestion,
} from "@opengeni/contracts";
/** Backward-compatible non-artifact client surface. */
export { OpenGeniDocumentAuthorityClient as OpenGeniCoreClient } from "./document-authority-client";
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
  OpenGeniSetupError,
  OpenGeniSecureContextRequiredError,
  OpenGeniSessionListCursorError,
  OpenGeniStreamError,
  formatErrorMessage,
  isMaintenanceError,
  isApprovalRequiresAccountOwnerError,
  APPROVAL_REQUIRES_ACCOUNT_OWNER_CODE,
  isRetryableStreamError,
  OPENGENI_MAINTENANCE_ERROR_CODE,
} from "./errors";
export type { OpenGeniSecureContextRequiredReason } from "./errors";
export { isTransientRequestError } from "./read-retry";
export type { OpenGeniReadRetryOptions } from "./read-retry";
export { resolveWorkspaceVoiceInputEnabled } from "./transcription";
export { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "./types";
