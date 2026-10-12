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
