import type { OpenGeniClient } from "@opengeni/sdk";

/**
 * The slice of `OpenGeniClient` the hooks depend on. Structural, so apps can
 * pass the real SDK client, a proxy-backed client that routes through their
 * own API, or a scripted client in tests/demos.
 */
export type SessionClientLike = Pick<
  OpenGeniClient,
  // Deployment config (host-exposed models, auth, upload limits)
  | "getClientConfig"
  // Sessions, events, composer
  | "getSession"
  | "updateSession"
  | "listSessions"
  | "sendMessage"
  | "steerMessage"
  | "interrupt"
  | "sendApprovalDecision"
  | "listEvents"
  | "streamEvents"
  // Turn queue
  | "listTurns"
  | "updateQueuedTurn"
  | "reorderQueuedTurns"
  | "deleteQueuedTurn"
  // Goal
  | "getGoal"
  | "updateGoal"
  // Operator context controls (/clear, /compact)
  | "clearSessionContext"
  | "compactSessionContext"
  // Scheduled tasks
  | "listScheduledTasks"
  // Files (upload + download-url minting for attachments)
  | "uploadFile"
  | "getFile"
  | "createFileDownloadUrl"
  // Environments
  | "listEnvironments"
  | "createEnvironment"
  | "updateEnvironment"
  | "deleteEnvironment"
  | "setEnvironmentVariable"
  | "deleteEnvironmentVariable"
  // Packs
  | "listPacks"
  | "registerPack"
  | "enablePack"
  | "deletePack"
  // Workspaces + billing
  | "listWorkspaces"
  | "createWorkspace"
  | "updateWorkspace"
  | "getBillingUsage"
  // Stream surfacing (Phase 5): capability negotiation + viewer lifecycle
  | "getClientConfig"
  | "getStreamCapabilities"
  | "acknowledgeStream"
  | "attachViewer"
  | "heartbeatViewer"
  | "detachViewer"
  // Channel-A structured services (terminal-as-events feed via fs/git/terminal)
  | "fsList"
  | "fsRead"
  | "fsWrite"
  | "fsDelete"
  | "fsMove"
  | "fsMkdir"
  | "gitStatus"
  | "gitDiff"
  | "terminalExec"
  | "terminalPtyOpen"
  | "terminalPtyWrite"
  | "terminalPtyResize"
  | "terminalPtyClose"
>;
