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
  | "getSessionLineage"
  | "updateSession"
  | "updateSessionPin"
  | "listSessions"
  | "listSessionPage"
  | "sendMessage"
  | "steerMessage"
  | "interrupt"
  | "sendApprovalDecision"
  | "listEvents"
  | "streamEvents"
  // Turn queue
  | "getQueue"
  | "editQueueItem"
  | "cancelQueueItem"
  | "promoteQueueItem"
  | "reorderQueue"
  // Legacy turn-history mutation helpers retained for host compatibility.
  | "listTurns"
  | "updateQueuedTurn"
  | "reorderQueuedTurns"
  | "deleteQueuedTurn"
  // Goal
  | "getGoal"
  | "updateGoal"
  | "deleteGoal"
  // Operator context controls (/clear, /compact)
  | "clearSessionContext"
  | "compactSessionContext"
  // Scheduled tasks
  | "listScheduledTasks"
  // Files (upload + download-url minting for attachments)
  | "uploadFile"
  | "getFile"
  | "createFileDownloadUrl"
  // VariableSets
  | "listVariableSets"
  | "createVariableSet"
  | "updateVariableSet"
  | "deleteVariableSet"
  | "setVariableSetVariable"
  | "deleteVariableSetVariable"
  | "listEnvironments"
  | "createEnvironment"
  | "updateEnvironment"
  | "deleteEnvironment"
  | "setEnvironmentVariable"
  | "deleteEnvironmentVariable"
  // Rigs
  | "listRigs"
  | "createRig"
  | "getRig"
  | "updateRig"
  | "deleteRig"
  | "listRigVersions"
  | "activateRigVersion"
  | "listRigChanges"
  | "proposeRigChange"
  | "getRigChange"
  | "verifyRigChange"
  | "promoteRigChange"
  | "verifyRig"
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
  // Workbench v2 turn-end capture reads (the cold-paint source; M3 consumes these)
  | "getWorkspaceCapture"
  | "getWorkspaceCaptureFile"
  | "terminalExec"
  | "terminalPtyOpen"
  | "terminalPtyWrite"
  | "terminalPtyResize"
  | "terminalPtyClose"
>;
