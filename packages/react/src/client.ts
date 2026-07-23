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
  | "pauseSession"
  | "resumeSession"
  | "sendApprovalDecision"
  | "listHumanInputRequests"
  | "getHumanInputRequest"
  | "submitHumanInputResponse"
  | "listEvents"
  | "streamEvents"
  // Turn queue
  | "getQueue"
  | "moveQueueItem"
  | "editQueueItem"
  | "steerQueueItem"
  | "deleteQueueItem"
  | "getComposerDraft"
  | "saveComposerDraft"
  | "listTurns"
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
  | "setWorkspaceInferenceState"
  | "getWorkspace"
  | "listWorkspaceControlEvents"
  | "streamWorkspaceControlEvents"
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

/**
 * Tenant-safe client surface required by the session-only React entry.
 *
 * A host proxy can implement only these session-scoped operations instead of
 * stubbing OpenGeni's workbench, billing, rig, file-system, and workspace
 * administration APIs. Workspace-level resume is deliberately optional: a
 * host that does not expose that authority still supports every session-local
 * composer/control path.
 */
export type EmbeddedSessionClientLike = Pick<
  OpenGeniClient,
  | "getSession"
  | "listEvents"
  | "streamEvents"
  | "getComposerDraft"
  | "saveComposerDraft"
  | "sendMessage"
  | "steerMessage"
  | "getQueue"
  | "moveQueueItem"
  | "editQueueItem"
  | "steerQueueItem"
  | "deleteQueueItem"
  | "pauseSession"
  | "resumeSession"
  | "sendApprovalDecision"
> & {
  setWorkspaceInferenceState?: OpenGeniClient["setWorkspaceInferenceState"] | undefined;
};

/** Session client refinement required only by structured human-input hooks. */
export type EmbeddedHumanInputSessionClientLike = EmbeddedSessionClientLike &
  Pick<
    OpenGeniClient,
    "listHumanInputRequests" | "getHumanInputRequest" | "submitHumanInputResponse"
  >;
