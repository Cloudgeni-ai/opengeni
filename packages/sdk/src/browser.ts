/** Browser-console client. Optional SDK surfaces must not enter this eager graph. */
export { OpenGeniClient as OpenGeniBrowserClient } from "./client";
export type {
  SessionMessageSearchRequest,
  SessionMessageSearchMatch,
  SessionMessageSearchResponse,
  SessionMessagePreview,
  SessionMessagePreviewReference,
} from "./session-message-search";
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
  OpenGeniAllowanceExhaustedError,
  OpenGeniSessionUsageLimitReachedError,
  OpenGeniSessionUsageLimitUnsupportedError,
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
export {
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  OPENGENI_BROWSER_REQUEST_HEADERS,
  OPENGENI_CORRELATION_HEADER,
  OPENGENI_SDK_VERSION_HEADER,
} from "./types";

export type {
  ConnectorToolPermission,
  ConnectorToolPermissionEntry,
  ConnectorToolPermissionsResponse,
  UpdateConnectorToolPermissionsRequest,
  SessionMcpToolPermissionsResponse,
  UpdateSessionMcpToolPermissionsRequest,
} from "./types";
