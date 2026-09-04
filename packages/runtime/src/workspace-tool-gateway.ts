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
} from "./index";
