/**
 * Deliberately narrow API-facing entrypoint for the canonical MCP preparation
 * path shared with model execution and Codemode. It exposes no Agent, Runner,
 * RunState, sandbox, or inference API.
 */
export {
  // A connection that cannot serve an approved call; nothing reached the provider.
  ConnectionApprovalPreflightError,
  // A server that could not be reached / a request that provably never left.
  isMcpRequestNotSentError,
  isMcpServerUnreachableError,
  // The access a first-party bridge's tool needs beyond an account's grants.
  mcpToolScopeNeed,
  prepareAgentTools as prepareWorkspaceToolGatewayTools,
  type LocalMcpServerRegistration,
  type PreparedAgentTools as PreparedWorkspaceToolGatewayTools,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
  // Secret-free identity that keys session MCP tool permission rules; the
  // gateway must derive it exactly as model execution does.
  sessionMcpApprovalConnectionId,
} from "./index";
// A call that needs one of the account's values chosen; nothing was sent.
export { isMcpAccountParameterChoiceError } from "./mcp-account-parameters";
// A server's namespace: the `server` in its tools' `<server>__<tool>` names.
export { mcpServerNamespace } from "./mcp-model-tool-name";
// Execution-time `{{secret:…}}` argument resolution for gateway tool calls;
// the same resolver model execution applies after approval.
export {
  createSecretArgumentResolver,
  handOffSecretArguments,
  literalSecretScope,
  secretArgumentMode,
  type LiteralSecretScope,
  type SecretArgumentMode,
} from "./secret-argument-resolution";
