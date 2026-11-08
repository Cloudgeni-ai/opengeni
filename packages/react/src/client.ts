import type { OpenGeniClient } from "@opengeni/sdk";
import type { ChatClient } from "@opengeni/sdk";

/**
 * The slice of `OpenGeniClient` the hooks depend on. Structural, so apps can
 * pass the real SDK client, a proxy-backed client that routes through their
 * own API, or a scripted client in tests/demos.
 * Public structural types default to the historical full SDK contract. Internal
 * render-only clients explicitly use the `ChatClient` parameter.
 */
type SessionClientMethods<Client extends ChatClient = OpenGeniClient> = Pick<
  Client,
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
      Client,
      | "createVideoArtifactPlaybackSource"
      | "streamWorkspaceLiveEvents"
      | "listSessionBackgroundCommands"
      | "listWorkspaceBackgroundCommands"
      | "cancelSessionBackgroundCommand"
      | "getComputerInputPosture"
      | "getSessionModelAccount"
    >
  >;

/**
 * Compact list transport is optional for scripted and older clients, and so is
 * the attention mutation an open conversation uses to mark itself read.
 */
export type SessionClientLike<Client extends ChatClient = OpenGeniClient> =
  SessionClientMethods<Client> &
    Partial<Pick<Client, "listSessionSummaryPage" | "findGoal" | "updateSessionAttention">>;

/**
 * Tenant-safe client surface required by the session-only React entry.
 *
 * A host proxy can implement only these session-scoped operations instead of
 * stubbing Opengeni's workbench, billing, rig, file-system, and workspace
 * administration APIs. Workspace-level resume is deliberately optional: a
 * host that does not expose that authority still supports every session-local
 * composer/control path.
 */
export type EmbeddedSessionClientLike<Client extends ChatClient = OpenGeniClient> = Pick<
  Client,
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
  setWorkspaceInferenceState?: Client["setWorkspaceInferenceState"] | undefined;
  /**
   * Optional: lets an open conversation mark itself read while the person
   * watches it. Without it the conversation works, but replies stay unread.
   */
  updateSessionAttention?: Client["updateSessionAttention"] | undefined;
  /**
   * Optional: lets conversation history see what the server's history filter
   * applied and whether a page has more. Without it history stays correct on
   * every server version, but keeps each long turn's tool calls and model
   * bookkeeping in its reads.
   */
  listEventPage?: Client["listEventPage"] | undefined;
};

/** Event-read surface shared by hooks that optionally tail a session. */
export type EmbeddedSessionEventClientLike<Client extends ChatClient = OpenGeniClient> = Pick<
  Client,
  "getSession" | "streamEvents"
>;

/** Exact client surface required by {@link useSession}. */
export type EmbeddedSessionReadClientLike<Client extends ChatClient = OpenGeniClient> =
  EmbeddedSessionEventClientLike<Client> & Pick<Client, "getSession" | "updateSession">;

/**
 * Exact client surface required by {@link useGoal}. `findGoal` is optional:
 * when present the hook reads a goal-less session as a successful `null`
 * instead of an absorbed 404.
 */
export type EmbeddedGoalClientLike<Client extends ChatClient = OpenGeniClient> =
  EmbeddedSessionEventClientLike<Client> &
    Pick<Client, "getGoal" | "updateGoal" | "deleteGoal"> & {
      findGoal?: Client["findGoal"] | undefined;
    };

/** Exact client surface required by {@link useSessionLineage}. */
export type EmbeddedSessionLineageClientLike<Client extends ChatClient = OpenGeniClient> =
  EmbeddedSessionEventClientLike<Client> & Pick<Client, "getSessionLineage">;

/**
 * Exact client surface required by {@link useFileAttachments}. The optional
 * reads show stored files: a restored draft's metadata and image previews.
 */
export type EmbeddedFileAttachmentClientLike<Client extends ChatClient = OpenGeniClient> = Pick<
  Client,
  "uploadFile"
> &
  Partial<Pick<Client, "createFileDownloadUrl" | "getFile">>;

/** Exact client surface required by structured human-input hooks. */
export type EmbeddedHumanInputSessionClientLike<Client extends ChatClient = OpenGeniClient> =
  EmbeddedSessionEventClientLike<Client> &
    Pick<Client, "listHumanInputRequests" | "submitHumanInputResponse">;

/** Exact client surface required by MCP approval-policy hooks. */
export type EmbeddedSessionMcpApprovalPolicyClientLike<Client extends ChatClient = OpenGeniClient> =
  EmbeddedSessionEventClientLike<Client> & Pick<Client, "updateSessionMcpApprovalPolicy">;

/** Exact client surface required by the public realtime React subpath. */
export type EmbeddedRealtimeSessionClientLike<Client extends ChatClient = OpenGeniClient> = Pick<
  Client,
  | "getWorkspaceRealtimeModelCatalog"
  | "beginSessionRealtime"
  | "heartbeatSessionRealtime"
  | "negotiateCodexRealtimeWebrtc"
  | "negotiateGatewayRealtime"
  | "negotiateXaiSubscriptionRealtime"
  | "activateCodexRealtimeConnection"
  | "syncSessionRealtimeLedger"
  | "endSessionRealtime"
> &
  Partial<Pick<Client, "negotiateRealtimeWebsocket">>;

/** Exact public SDK surface required by cross-surface human interventions. */
export type EmbeddedInterventionClientLike<Client extends ChatClient = OpenGeniClient> = Pick<
  Client,
  | "streamWorkspaceInteractionRevisions"
  | "listInteractionInterventions"
  | "getInteractionIntervention"
  | "createInteractionIntervention"
  | "resolveInteractionIntervention"
>;

/** Exact public SDK surface required by BrowserSession hooks and components. */
export type EmbeddedBrowserInteractionClientLike<Client extends ChatClient = OpenGeniClient> = Pick<
  Client,
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
  EmbeddedInterventionClientLike<Client>;

/** Exact public SDK surface required by ComputerSession hooks and components. */
export type EmbeddedComputerInteractionClientLike<Client extends ChatClient = OpenGeniClient> =
  Pick<
    Client,
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
    EmbeddedInterventionClientLike<Client> &
    Partial<Pick<Client, "getComputerInputPosture">>;

/** Complete public Browser + Computer interaction surface. */
export type EmbeddedInteractionClientLike<Client extends ChatClient = OpenGeniClient> =
  EmbeddedBrowserInteractionClientLike<Client> & EmbeddedComputerInteractionClientLike<Client>;
