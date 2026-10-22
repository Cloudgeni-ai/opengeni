/**
 * Deliberately narrow API-facing entrypoint for the canonical MCP preparation
 * path shared with model execution and Codemode. It exposes no Agent, Runner,
 * RunState, sandbox, or inference API.
 */
export {
  prepareAgentTools as prepareWorkspaceToolGatewayTools,
  type LocalMcpServerRegistration,
  type PreparedAgentTools as PreparedWorkspaceToolGatewayTools,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
  // Secret-free identity that keys session MCP tool permission rules; the
  // gateway must derive it exactly as model execution does.
  sessionMcpApprovalConnectionId,
} from "./index";
// Execution-time `{{secret:…}}` argument resolution for gateway tool calls;
// the same resolver model execution applies after approval.
export {
  createSecretArgumentResolver,
  secretArgumentMode,
  type SecretArgumentMode,
} from "./secret-argument-resolution";
