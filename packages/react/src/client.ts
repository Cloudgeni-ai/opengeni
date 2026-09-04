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
  | "submitComposerDraft"
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
  | "getVariableSetVariable"
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
  // Channels (rail organization)
  | "listChannels"
  | "createChannel"
  | "updateChannel"
  | "reorderChannels"
  | "deleteChannel"
  | "updateSessionChannel"
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
  | "previewPackInstallation"
  | "installPack"
  | "previewPackUninstall"
  | "uninstallPack"
  | "deletePack"
  // Workspaces + billing
  | "listWorkspaces"
  | "createWorkspace"
  | "updateWorkspace"
  | "setWorkspaceInferenceState"
  | "getWorkspace"
  | "getWorkspaceModelCatalog"
  | "listWorkspaceControlEvents"
  | "streamWorkspaceControlEvents"
  | "streamWorkspaceInteractionRevisions"
  | "getBillingUsage"
  // Stream surfacing (Phase 5): capability negotiation + viewer lifecycle
  | "getClientConfig"
  | "getStreamCapabilities"
  | "acknowledgeStream"
  | "attachViewer"
  | "heartbeatViewer"
  | "detachViewer"
  // Browser/Computer interaction resources
  | "listNetworkRoutes"
  | "getNetworkRoute"
  | "createNetworkRoute"
  | "updateNetworkRoute"
  | "listSiteAuthConnections"
  | "getSiteAuthConnection"
  | "createSiteAuthConnection"
  | "updateSiteAuthConnection"
  | "listAuthRuns"
  | "getAuthRun"
  | "startBrowserAuthRun"
  | "reportBrowserAuthRun"
  | "protectedBrowserAuthFill"
  | "verifyBrowserAuthRun"
  | "listInteractionInterventions"
  | "getInteractionIntervention"
  | "createInteractionIntervention"
  | "resolveInteractionIntervention"
  | "listAttachedBrowsers"
  | "getAttachedBrowser"
  | "listBrowserIdentities"
  | "getBrowserIdentity"
  | "createBrowserIdentity"
  | "updateBrowserIdentity"
  | "listBrowserRevisions"
  | "listBrowserSessions"
  | "getBrowserSession"
  | "readBrowserClipboard"
  | "listBrowserDownloads"
  | "getBrowserDownload"
  | "saveBrowserDownload"
  | "createBrowserSession"
  | "listBrowserTargets"
  | "openBrowserTarget"
  | "selectBrowserTarget"
  | "closeBrowserTarget"
  | "observeBrowserTarget"
  | "actInBrowser"
  | "getBrowserActionReceipt"
  | "listBrowserDiagnostics"
  | "attachBrowserSession"
  | "heartbeatBrowserSession"
  | "publishBrowserRevision"
  | "suspendBrowserSession"
  | "resumeBrowserSession"
  | "endBrowserSession"
  | "listComputerSessions"
  | "getComputerSession"
  | "readComputerClipboard"
  | "createComputerSession"
  | "listComputerTargets"
  | "observeComputerTarget"
  | "actInComputer"
  | "getComputerActionReceipt"
  | "attachComputerSession"
  | "heartbeatComputerSession"
  | "endComputerSession"
  // Channel-A structured services (terminal-as-events feed via fs/git/terminal)
  | "fsList"
  | "fsListBatch"
  | "fsRead"
  | "fsWrite"
  | "fsDelete"
  | "fsMove"
  | "fsMkdir"
  | "gitStatus"
  | "gitDiff"
  | "gitReadBatch"
  // Workbench v2 turn-end capture reads (the cold-paint source; M3 consumes these)
  | "getWorkspaceCapture"
  | "getWorkspaceCaptureFile"
  | "terminalExec"
  | "terminalPtyOpen"
  | "terminalPtyWrite"
  | "terminalPtyResize"
  | "terminalPtyClose"
> &
  Partial<
    Pick<
      OpenGeniClient,
      | "createVideoArtifactPlaybackSource"
      | "streamWorkspaceLiveEvents"
      | "listSessionBackgroundCommands"
      | "cancelSessionBackgroundCommand"
    >
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
  | "submitComposerDraft"
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

/** Event-read surface shared by hooks that optionally tail a session. */
export type EmbeddedSessionEventClientLike = Pick<OpenGeniClient, "getSession" | "streamEvents">;

/** Exact client surface required by {@link useSession}. */
export type EmbeddedSessionReadClientLike = EmbeddedSessionEventClientLike &
  Pick<OpenGeniClient, "getSession" | "updateSession">;

/** Exact client surface required by {@link useGoal}. */
export type EmbeddedGoalClientLike = EmbeddedSessionEventClientLike &
  Pick<OpenGeniClient, "getGoal" | "updateGoal" | "deleteGoal">;

/** Exact client surface required by {@link useSessionLineage}. */
export type EmbeddedSessionLineageClientLike = EmbeddedSessionEventClientLike &
  Pick<OpenGeniClient, "getSessionLineage">;

/** Exact client surface required by {@link useFileAttachments}. */
export type EmbeddedFileAttachmentClientLike = Pick<OpenGeniClient, "uploadFile"> &
  Partial<Pick<OpenGeniClient, "createFileDownloadUrl">>;

/** Exact client surface required by structured human-input hooks. */
export type EmbeddedHumanInputSessionClientLike = EmbeddedSessionEventClientLike &
  Pick<OpenGeniClient, "listHumanInputRequests" | "submitHumanInputResponse">;

/** Exact client surface required by MCP approval-policy hooks. */
export type EmbeddedSessionMcpApprovalPolicyClientLike = EmbeddedSessionEventClientLike &
  Pick<OpenGeniClient, "updateSessionMcpApprovalPolicy">;

/** Exact client surface required by the public realtime React subpath. */
export type EmbeddedRealtimeSessionClientLike = Pick<
  OpenGeniClient,
  | "getWorkspaceRealtimeModelCatalog"
  | "beginSessionRealtime"
  | "heartbeatSessionRealtime"
  | "negotiateCodexRealtimeWebrtc"
  | "negotiateGatewayRealtime"
  | "negotiateXaiSubscriptionRealtime"
  | "activateCodexRealtimeConnection"
  | "syncSessionRealtimeLedger"
  | "endSessionRealtime"
>;

/** Exact public SDK surface required by cross-surface human interventions. */
export type EmbeddedInterventionClientLike = Pick<
  OpenGeniClient,
  | "streamWorkspaceInteractionRevisions"
  | "listInteractionInterventions"
  | "getInteractionIntervention"
  | "createInteractionIntervention"
  | "resolveInteractionIntervention"
>;

/** Exact public SDK surface required by BrowserSession hooks and components. */
export type EmbeddedBrowserInteractionClientLike = Pick<
  OpenGeniClient,
  | "streamWorkspaceInteractionRevisions"
  | "listNetworkRoutes"
  | "getNetworkRoute"
  | "createNetworkRoute"
  | "updateNetworkRoute"
  | "listSiteAuthConnections"
  | "getSiteAuthConnection"
  | "createSiteAuthConnection"
  | "updateSiteAuthConnection"
  | "listAuthRuns"
  | "getAuthRun"
  | "startBrowserAuthRun"
  | "reportBrowserAuthRun"
  | "protectedBrowserAuthFill"
  | "verifyBrowserAuthRun"
  | "listInteractionInterventions"
  | "getInteractionIntervention"
  | "createInteractionIntervention"
  | "resolveInteractionIntervention"
  | "listAttachedBrowsers"
  | "getAttachedBrowser"
  | "listBrowserIdentities"
  | "getBrowserIdentity"
  | "createBrowserIdentity"
  | "updateBrowserIdentity"
  | "listBrowserRevisions"
  | "listBrowserSessions"
  | "getBrowserSession"
  | "readBrowserClipboard"
  | "listBrowserDownloads"
  | "getBrowserDownload"
  | "saveBrowserDownload"
  | "createBrowserSession"
  | "listBrowserTargets"
  | "openBrowserTarget"
  | "selectBrowserTarget"
  | "closeBrowserTarget"
  | "observeBrowserTarget"
  | "actInBrowser"
  | "getBrowserActionReceipt"
  | "listBrowserDiagnostics"
  | "attachBrowserSession"
  | "heartbeatBrowserSession"
  | "publishBrowserRevision"
  | "suspendBrowserSession"
  | "resumeBrowserSession"
  | "endBrowserSession"
> &
  EmbeddedInterventionClientLike;

/** Exact public SDK surface required by ComputerSession hooks and components. */
export type EmbeddedComputerInteractionClientLike = Pick<
  OpenGeniClient,
  | "streamWorkspaceInteractionRevisions"
  | "listComputerSessions"
  | "getComputerSession"
  | "readComputerClipboard"
  | "createComputerSession"
  | "listComputerTargets"
  | "observeComputerTarget"
  | "actInComputer"
  | "getComputerActionReceipt"
  | "attachComputerSession"
  | "heartbeatComputerSession"
  | "endComputerSession"
> &
  EmbeddedInterventionClientLike;

/** Complete public Browser + Computer interaction surface. */
export type EmbeddedInteractionClientLike = EmbeddedBrowserInteractionClientLike &
  EmbeddedComputerInteractionClientLike;
