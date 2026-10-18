// Running the connected-machine agent from a desktop app, so the person's
// agents can work on the computer the app runs on ("Use this computer").
// Node only; the app passes in what needs its own platform (network, trash,
// System Settings, the API client).
export {
  ThisComputer,
  ThisComputerError,
  newlyGranted,
  type ThisComputerDeps,
} from "./this-computer";
export { allowAgentsOnComputer, type ComputerGrantClient } from "@opengeni/sdk/this-computer";
export { computerName, hostLabel } from "./computer-name";
export {
  connectionFor,
  hostedAgentPath,
  lastErrorLine,
  parseAgentVersion,
  parseConnections,
  parsePermissions,
  standaloneMacAgentApp,
  type AgentConnection,
  type AgentPermissionId,
  type AgentPlatform,
} from "./agent-cli";
export {
  OPENGENI_AGENT_SIGNING_KEY,
  agentAssetName,
  parsePublicKey,
  parseSignatureFile,
  signedHash,
  verifyAgentSignature,
  type StreamingHash,
} from "./agent-download";
export {
  HostedAgent,
  RESTART_EXIT_CODE,
  type AgentChild,
  type HostedAgentDeps,
  type HostedAgentState,
} from "./hosted-agent";
export type {
  ThisComputerConnectOptions,
  ThisComputerErrorCode,
  ThisComputerHost,
  ThisComputerPermission,
  ThisComputerPermissionId,
  ThisComputerState,
  ThisComputerStatus,
} from "@opengeni/sdk/this-computer";
