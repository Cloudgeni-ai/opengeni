// Everything a renderer needs to let a person finish an agent's "connect your
// account" request inside the chat, without the web components: the decision
// which card to show, the connect flows those cards drive, and the words of
// the fallback row. The web cards and the React Native cards both use it, so
// both make the same choices. No DOM, styles or assets.
import type { Permission } from "@opengeni/sdk";
import type { InChatConnectSupport } from "./components/conversation-capability-connect";
import { isAgentCapabilityRequest } from "./components/conversation-capability-connect";
import { isPreparedMcpSetup } from "./components/prepared-mcp-setup-flow";
import type { AuthNeededItem } from "./timeline";

export {
  inChatConnectDecision,
  isAgentCapabilityRequest,
  useInChatConnectSupport,
  type InChatConnectDecision,
  type InChatConnectSource,
  type InChatConnectSupport,
} from "./components/conversation-capability-connect";
export {
  reconnectCandidate,
  useIntegrationCapabilityConnect,
  type IntegrationCapabilityAvailability,
  type IntegrationCapabilityConnect,
  type IntegrationCapabilityConnectInput,
} from "./components/integration-capability-connect-flow";
export {
  useMcpCapabilityConnect,
  type McpCapabilityConnect,
  type McpCapabilityConnectInput,
} from "./components/mcp-capability-connect-flow";
export {
  isPreparedMcpSetup,
  usePreparedMcpSetupAccess,
  usePreparedMcpSetupAttempt,
} from "./components/prepared-mcp-setup-flow";
export {
  connectSetupStatus,
  useConnectSetupFlow,
  type ConnectSetupFlow,
  type ConnectSetupFlowOptions,
} from "./connect-setup-model";
export { attemptHint, type ConnectWindowHost } from "./connect-window-host";
export type { ConnectAttempt, ConnectController, ConnectNavigation } from "@opengeni/connect";
export { useConnect } from "./hooks/use-connect";
export {
  authNeededPresentation,
  providerLabel,
  type AuthNeededPresentation,
} from "./auth-needed-presentation";

/** Whether the chat shows a request this person might finish in the chat. */
export function isInChatConnectRequest(item: AuthNeededItem): boolean {
  return isAgentCapabilityRequest(item) || isPreparedMcpSetup(item);
}

/**
 * Whether this person may finish an agent's prepared key setup: it connects
 * a credential and installs a server, so it needs both permissions.
 */
export function canFinishPreparedMcpSetup(support: InChatConnectSupport): boolean {
  if (support.status !== "ready") return false;
  const can = (permission: Permission) =>
    support.permissions.has(permission) ||
    (support.permissionMode !== "explicit" && support.permissions.has("workspace:admin"));
  return can("connections:write") && can("capabilities:manage");
}
