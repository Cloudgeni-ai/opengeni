import type { OpenGeniClient } from "@opengeni/sdk";
import type { ChatClient } from "@opengeni/sdk";
import type {
  StreamConnectionState,
  WorkspaceControlEvent,
  WorkspaceDraftsChangedEvent,
  WorkspaceInteractionRevisionEvent,
  WorkspaceSessionListEvent,
} from "@opengeni/sdk";
import { createContext, useContext } from "react";
import type {
  EmbeddedFileAttachmentClientLike,
  EmbeddedGoalClientLike,
  EmbeddedHumanInputSessionClientLike,
  EmbeddedBrowserInteractionClientLike,
  EmbeddedComputerInteractionClientLike,
  EmbeddedInteractionClientLike,
  EmbeddedInterventionClientLike,
  EmbeddedRealtimeSessionClientLike,
  EmbeddedSessionClientLike,
  EmbeddedSessionLineageClientLike,
  EmbeddedSessionMcpApprovalPolicyClientLike,
  EmbeddedSessionReadClientLike,
  SessionClientLike,
} from "./client";

export type OpenGeniContextValue<Client extends ChatClient = OpenGeniClient> = {
  client: SessionClientLike<Client>;
  workspaceId: string;
  workspaceControlEvent: WorkspaceControlEvent | null;
  workspaceControlConnectionState: StreamConnectionState | "idle" | "error";
  workspaceInteractionEvent: WorkspaceInteractionRevisionEvent | null;
  workspaceInteractionConnectionState: StreamConnectionState | "idle" | "error";
  /** Absent on older/custom hosts: retain the existing polling fallback. */
  workspaceSessionListEvent?: WorkspaceSessionListEvent | null;
  /**
   * The latest "your drafts changed on another device" hint. Absent on older
   * or custom hosts: composers then keep their draft until they reload it.
   */
  workspaceDraftsEvent?: WorkspaceDraftsChangedEvent | null;
  registerSessionReconciler: (
    sessionId: string,
    key: string,
    reconcile: () => Promise<void>,
  ) => () => void;
  /**
   * Repair every registered projection of a session when its live stream
   * (re)opens. `initialOpen` marks the first open after a fresh tail load, when
   * each projection was just read alongside that tail: only the API-contract
   * check runs then.
   */
  reconcileSession: (
    sessionId: string,
    options?: { initialOpen?: boolean | undefined },
  ) => Promise<void>;
};

export const OpenGeniContext = createContext<OpenGeniContextValue<ChatClient> | null>(null);

const NOOP_REGISTER_RECONCILER: OpenGeniContextValue<ChatClient>["registerSessionReconciler"] =
  () => () =>
    undefined;
const NOOP_RECONCILE_SESSION: OpenGeniContextValue<ChatClient>["reconcileSession"] = async () =>
  undefined;

export type ClientOverride<Client extends ChatClient = OpenGeniClient> = {
  client?: SessionClientLike<Client> | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedSessionClientOverride<Client extends ChatClient = OpenGeniClient> = {
  client?: EmbeddedSessionClientLike<Client> | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedHumanInputClientOverride<Client extends ChatClient = OpenGeniClient> = {
  client?: EmbeddedHumanInputSessionClientLike<Client> | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedSessionMcpApprovalPolicyClientOverride<
  Client extends ChatClient = OpenGeniClient,
> = {
  client?: EmbeddedSessionMcpApprovalPolicyClientLike<Client> | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedSessionReadClientOverride<Client extends ChatClient = OpenGeniClient> = {
  client?: EmbeddedSessionReadClientLike<Client> | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedRealtimeSessionClientOverride<Client extends ChatClient = OpenGeniClient> = {
  client?: EmbeddedRealtimeSessionClientLike<Client> | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedGoalClientOverride<Client extends ChatClient = OpenGeniClient> = {
  client?: EmbeddedGoalClientLike<Client> | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedSessionLineageClientOverride<Client extends ChatClient = OpenGeniClient> = {
  client?: EmbeddedSessionLineageClientLike<Client> | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedFileAttachmentClientOverride<Client extends ChatClient = OpenGeniClient> = {
  client?: EmbeddedFileAttachmentClientLike<Client> | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedInteractionClientOverride<Client extends ChatClient = OpenGeniClient> = {
  client?: EmbeddedInteractionClientLike<Client> | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedInterventionClientOverride<Client extends ChatClient = OpenGeniClient> = {
  client?: EmbeddedInterventionClientLike<Client> | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedBrowserInteractionClientOverride<Client extends ChatClient = OpenGeniClient> = {
  client?: EmbeddedBrowserInteractionClientLike<Client> | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedComputerInteractionClientOverride<Client extends ChatClient = OpenGeniClient> =
  {
    client?: EmbeddedComputerInteractionClientLike<Client> | undefined;
    workspaceId?: string | undefined;
  };

export type EmbeddedSessionContextValue<Client extends ChatClient = OpenGeniClient> = Omit<
  OpenGeniContextValue<ChatClient>,
  "client"
> & {
  client: EmbeddedSessionClientLike<Client>;
};

type EmbeddedClientOverride<TClient> = {
  client?: TClient | undefined;
  workspaceId?: string | undefined;
};

type EmbeddedClientContextValue<TClient> = Omit<OpenGeniContextValue<ChatClient>, "client"> & {
  client: TClient;
};

function useEmbeddedClientRefinement<TClient extends object>(
  override: EmbeddedClientOverride<TClient>,
  requiredMethods: readonly string[],
  hookName: string,
): EmbeddedClientContextValue<TClient> {
  const context = useContext(OpenGeniContext);
  const candidate = override.client ?? context?.client;
  const workspaceId = override.workspaceId ?? context?.workspaceId;
  if (!candidate || !workspaceId) {
    throw new Error(
      "@opengeni/react: no Opengeni client/workspace available. Wrap the tree in <OpenGeniProvider> or pass { client, workspaceId } to the hook.",
    );
  }
  const methods = candidate as Record<string, unknown>;
  const missing = requiredMethods.filter((method) => typeof methods[method] !== "function");
  if (missing.length > 0) {
    throw new Error(
      `@opengeni/react: ${hookName} requires client method${missing.length === 1 ? "" : "s"} ${missing.join(", ")}.`,
    );
  }
  return {
    client: candidate as TClient,
    workspaceId,
    workspaceControlEvent: context?.workspaceControlEvent ?? null,
    workspaceControlConnectionState: context?.workspaceControlConnectionState ?? "idle",
    workspaceInteractionEvent: context?.workspaceInteractionEvent ?? null,
    workspaceSessionListEvent: context?.workspaceSessionListEvent ?? null,
    workspaceDraftsEvent: context?.workspaceDraftsEvent ?? null,
    workspaceInteractionConnectionState: context?.workspaceInteractionConnectionState ?? "idle",
    registerSessionReconciler: context?.registerSessionReconciler ?? NOOP_REGISTER_RECONCILER,
    reconcileSession: context?.reconcileSession ?? NOOP_RECONCILE_SESSION,
  };
}

function eventClientMethods(override: object, directMethods: readonly string[]): readonly string[] {
  const hasSharedEventFeed =
    "events" in override && (override as { events?: unknown }).events !== undefined;
  return hasSharedEventFeed ? directMethods : ["getSession", "streamEvents", ...directMethods];
}

/** Resolve client + workspace from explicit overrides or the provider. */
export function useOpenGeni(override?: ClientOverride): OpenGeniContextValue;
export function useOpenGeni(
  override?: ClientOverride<ChatClient>,
): OpenGeniContextValue<ChatClient>;
export function useOpenGeni(
  override: ClientOverride<ChatClient> = {},
): OpenGeniContextValue<ChatClient> {
  const context = useContext(OpenGeniContext);
  const client = override.client ?? context?.client;
  const workspaceId = override.workspaceId ?? context?.workspaceId;
  if (!client || !workspaceId) {
    throw new Error(
      "@opengeni/react: no Opengeni client/workspace available. Wrap the tree in <OpenGeniProvider> or pass { client, workspaceId } to the hook.",
    );
  }
  return {
    client,
    workspaceId,
    workspaceControlEvent: context?.workspaceControlEvent ?? null,
    workspaceControlConnectionState: context?.workspaceControlConnectionState ?? "idle",
    workspaceInteractionEvent: context?.workspaceInteractionEvent ?? null,
    workspaceSessionListEvent: context?.workspaceSessionListEvent ?? null,
    workspaceDraftsEvent: context?.workspaceDraftsEvent ?? null,
    workspaceInteractionConnectionState: context?.workspaceInteractionConnectionState ?? "idle",
    registerSessionReconciler: context?.registerSessionReconciler ?? NOOP_REGISTER_RECONCILER,
    reconcileSession: context?.reconcileSession ?? NOOP_RECONCILE_SESSION,
  };
}

const BROWSER_INTERACTION_METHODS = [
  "streamWorkspaceInteractionRevisions",
  "listNetworkRoutes",
  "getNetworkRoute",
  "createNetworkRoute",
  "updateNetworkRoute",
  "listSiteAuthConnections",
  "getSiteAuthConnection",
  "createSiteAuthConnection",
  "updateSiteAuthConnection",
  "listAuthRuns",
  "getAuthRun",
  "startBrowserAuthRun",
  "reportBrowserAuthRun",
  "verifyBrowserAuthRun",
  "listInteractionInterventions",
  "getInteractionIntervention",
  "createInteractionIntervention",
  "resolveInteractionIntervention",
  "listAttachedBrowsers",
  "getAttachedBrowser",
  "listBrowserIdentities",
  "getBrowserIdentity",
  "createBrowserIdentity",
  "updateBrowserIdentity",
  "listBrowserRevisions",
  "listBrowserSessions",
  "getBrowserSession",
  "readBrowserClipboard",
  "listBrowserDownloads",
  "getBrowserDownload",
  "saveBrowserDownload",
  "createBrowserSession",
  "listBrowserTargets",
  "openBrowserTarget",
  "selectBrowserTarget",
  "closeBrowserTarget",
  "observeBrowserTarget",
  "actInBrowser",
  "getBrowserActionReceipt",
  "listBrowserDiagnostics",
  "attachBrowserSession",
  "heartbeatBrowserSession",
  "publishBrowserRevision",
  "suspendBrowserSession",
  "resumeBrowserSession",
  "endBrowserSession",
] as const;

const COMPUTER_INTERACTION_METHODS = [
  "streamWorkspaceInteractionRevisions",
  "listInteractionInterventions",
  "getInteractionIntervention",
  "createInteractionIntervention",
  "resolveInteractionIntervention",
  "listComputerSessions",
  "getComputerSession",
  "readComputerClipboard",
  "createComputerSession",
  "listComputerTargets",
  "observeComputerTarget",
  "actInComputer",
  "getComputerActionReceipt",
  "attachComputerSession",
  "heartbeatComputerSession",
  "endComputerSession",
] as const;

const INTERVENTION_METHODS = [
  "streamWorkspaceInteractionRevisions",
  "listInteractionInterventions",
  "getInteractionIntervention",
  "createInteractionIntervention",
  "resolveInteractionIntervention",
] as const;

/** Resolve only the workspace-wide Browser/Computer intervention surface. */
export function useEmbeddedInterventions(
  override?: EmbeddedInterventionClientOverride,
): EmbeddedClientContextValue<EmbeddedInterventionClientLike>;
export function useEmbeddedInterventions(
  override?: EmbeddedInterventionClientOverride<ChatClient>,
): EmbeddedClientContextValue<EmbeddedInterventionClientLike<ChatClient>>;
export function useEmbeddedInterventions(
  override: EmbeddedInterventionClientOverride<ChatClient> = {},
): EmbeddedClientContextValue<EmbeddedInterventionClientLike<ChatClient>> {
  return useEmbeddedClientRefinement(
    override,
    INTERVENTION_METHODS,
    "interaction intervention hooks",
  );
}

/** Resolve only BrowserSession methods for a standalone Browser embed. */
export function useEmbeddedBrowserInteraction(
  override?: EmbeddedBrowserInteractionClientOverride,
): EmbeddedClientContextValue<EmbeddedBrowserInteractionClientLike>;
export function useEmbeddedBrowserInteraction(
  override?: EmbeddedBrowserInteractionClientOverride<ChatClient>,
): EmbeddedClientContextValue<EmbeddedBrowserInteractionClientLike<ChatClient>>;
export function useEmbeddedBrowserInteraction(
  override: EmbeddedBrowserInteractionClientOverride<ChatClient> = {},
): EmbeddedClientContextValue<EmbeddedBrowserInteractionClientLike<ChatClient>> {
  return useEmbeddedClientRefinement(
    override,
    BROWSER_INTERACTION_METHODS,
    "browser interaction hooks",
  );
}

/** Resolve only ComputerSession methods for a standalone Computer embed. */
export function useEmbeddedComputerInteraction(
  override?: EmbeddedComputerInteractionClientOverride,
): EmbeddedClientContextValue<EmbeddedComputerInteractionClientLike>;
export function useEmbeddedComputerInteraction(
  override?: EmbeddedComputerInteractionClientOverride<ChatClient>,
): EmbeddedClientContextValue<EmbeddedComputerInteractionClientLike<ChatClient>>;
export function useEmbeddedComputerInteraction(
  override: EmbeddedComputerInteractionClientOverride<ChatClient> = {},
): EmbeddedClientContextValue<EmbeddedComputerInteractionClientLike<ChatClient>> {
  return useEmbeddedClientRefinement(
    override,
    COMPUTER_INTERACTION_METHODS,
    "computer interaction hooks",
  );
}

/** Resolve the complete Browser + Computer client surface. */
export function useEmbeddedInteraction(
  override?: EmbeddedInteractionClientOverride,
): EmbeddedClientContextValue<EmbeddedInteractionClientLike>;
export function useEmbeddedInteraction(
  override?: EmbeddedInteractionClientOverride<ChatClient>,
): EmbeddedClientContextValue<EmbeddedInteractionClientLike<ChatClient>>;
export function useEmbeddedInteraction(
  override: EmbeddedInteractionClientOverride<ChatClient> = {},
): EmbeddedClientContextValue<EmbeddedInteractionClientLike<ChatClient>> {
  return useEmbeddedClientRefinement(
    override,
    [...BROWSER_INTERACTION_METHODS, ...COMPUTER_INTERACTION_METHODS],
    "interaction hooks",
  );
}

/**
 * Resolve the narrow client required by the session-only hooks. The full
 * provider client is structurally compatible, while an explicit host proxy
 * only needs to expose session/event/composer/queue/control operations.
 */
export function useEmbeddedSession(
  override?: EmbeddedSessionClientOverride,
): EmbeddedSessionContextValue;
export function useEmbeddedSession(
  override?: EmbeddedSessionClientOverride<ChatClient>,
): EmbeddedSessionContextValue<ChatClient>;
export function useEmbeddedSession(
  override: EmbeddedSessionClientOverride<ChatClient> = {},
): EmbeddedSessionContextValue<ChatClient> {
  return useEmbeddedClientRefinement(
    override,
    [
      "getSession",
      "listEvents",
      "streamEvents",
      "getComposerDraft",
      "saveComposerDraft",
      "submitComposerDraft",
      "sendMessage",
      "steerMessage",
      "getQueue",
      "moveQueueItem",
      "editQueueItem",
      "steerQueueItem",
      "deleteQueueItem",
      "pauseSession",
      "resumeSession",
      "sendApprovalDecision",
    ],
    "session hooks",
  );
}

/** Resolve the exact client surface required by `useSession`. */
export function useEmbeddedSessionRead(
  override?: EmbeddedSessionReadClientOverride,
): EmbeddedClientContextValue<EmbeddedSessionReadClientLike>;
export function useEmbeddedSessionRead(
  override?: EmbeddedSessionReadClientOverride<ChatClient>,
): EmbeddedClientContextValue<EmbeddedSessionReadClientLike<ChatClient>>;
export function useEmbeddedSessionRead(
  override: EmbeddedSessionReadClientOverride<ChatClient> = {},
): EmbeddedClientContextValue<EmbeddedSessionReadClientLike<ChatClient>> {
  return useEmbeddedClientRefinement(
    override,
    eventClientMethods(override, ["getSession", "updateSession"]),
    "useSession",
  );
}

/** Resolve the exact client surface required by `useGoal`. */
export function useEmbeddedGoal(
  override?: EmbeddedGoalClientOverride,
): EmbeddedClientContextValue<EmbeddedGoalClientLike>;
export function useEmbeddedGoal(
  override?: EmbeddedGoalClientOverride<ChatClient>,
): EmbeddedClientContextValue<EmbeddedGoalClientLike<ChatClient>>;
export function useEmbeddedGoal(
  override: EmbeddedGoalClientOverride<ChatClient> = {},
): EmbeddedClientContextValue<EmbeddedGoalClientLike<ChatClient>> {
  return useEmbeddedClientRefinement(
    override,
    eventClientMethods(override, ["getGoal", "updateGoal", "deleteGoal"]),
    "useGoal",
  );
}

/** Resolve the exact client surface required by `useSessionLineage`. */
export function useEmbeddedSessionLineage(
  override?: EmbeddedSessionLineageClientOverride,
): EmbeddedClientContextValue<EmbeddedSessionLineageClientLike>;
export function useEmbeddedSessionLineage(
  override?: EmbeddedSessionLineageClientOverride<ChatClient>,
): EmbeddedClientContextValue<EmbeddedSessionLineageClientLike<ChatClient>>;
export function useEmbeddedSessionLineage(
  override: EmbeddedSessionLineageClientOverride<ChatClient> = {},
): EmbeddedClientContextValue<EmbeddedSessionLineageClientLike<ChatClient>> {
  return useEmbeddedClientRefinement(
    override,
    eventClientMethods(override, ["getSessionLineage"]),
    "useSessionLineage",
  );
}

/** Resolve the exact client surface required by `useFileAttachments`. */
export function useEmbeddedFileAttachments(
  override?: EmbeddedFileAttachmentClientOverride,
): EmbeddedClientContextValue<EmbeddedFileAttachmentClientLike>;
export function useEmbeddedFileAttachments(
  override?: EmbeddedFileAttachmentClientOverride<ChatClient>,
): EmbeddedClientContextValue<EmbeddedFileAttachmentClientLike<ChatClient>>;
export function useEmbeddedFileAttachments(
  override: EmbeddedFileAttachmentClientOverride<ChatClient> = {},
): EmbeddedClientContextValue<EmbeddedFileAttachmentClientLike<ChatClient>> {
  return useEmbeddedClientRefinement(override, ["uploadFile"], "useFileAttachments");
}

/**
 * Resolve the structured-input refinement without widening the baseline
 * session-only proxy contract.
 */
export function useEmbeddedHumanInputSession(override?: EmbeddedHumanInputClientOverride): Omit<
  EmbeddedSessionContextValue,
  "client"
> & {
  client: EmbeddedHumanInputSessionClientLike;
};
export function useEmbeddedHumanInputSession(
  override?: EmbeddedHumanInputClientOverride<ChatClient>,
): Omit<EmbeddedSessionContextValue<ChatClient>, "client"> & {
  client: EmbeddedHumanInputSessionClientLike<ChatClient>;
};
export function useEmbeddedHumanInputSession(
  override: EmbeddedHumanInputClientOverride<ChatClient> = {},
): Omit<EmbeddedSessionContextValue<ChatClient>, "client"> & {
  client: EmbeddedHumanInputSessionClientLike<ChatClient>;
} {
  return useEmbeddedClientRefinement(
    override,
    eventClientMethods(override, ["listHumanInputRequests", "submitHumanInputResponse"]),
    "useHumanInputRequests",
  );
}

/** Resolve the approval-policy refinement without widening session-only hosts. */
export function useEmbeddedSessionMcpApprovalPolicy(
  override?: EmbeddedSessionMcpApprovalPolicyClientOverride,
): Omit<EmbeddedSessionContextValue, "client"> & {
  client: EmbeddedSessionMcpApprovalPolicyClientLike;
};
export function useEmbeddedSessionMcpApprovalPolicy(
  override?: EmbeddedSessionMcpApprovalPolicyClientOverride<ChatClient>,
): Omit<EmbeddedSessionContextValue<ChatClient>, "client"> & {
  client: EmbeddedSessionMcpApprovalPolicyClientLike<ChatClient>;
};
export function useEmbeddedSessionMcpApprovalPolicy(
  override: EmbeddedSessionMcpApprovalPolicyClientOverride<ChatClient> = {},
): Omit<EmbeddedSessionContextValue<ChatClient>, "client"> & {
  client: EmbeddedSessionMcpApprovalPolicyClientLike<ChatClient>;
} {
  return useEmbeddedClientRefinement(
    override,
    eventClientMethods(override, ["getSession", "updateSessionMcpApprovalPolicy"]),
    "useSessionMcpApprovalPolicy",
  );
}

/** Resolve the exact browser/API surface required by `@opengeni/react/realtime`. */
export function useEmbeddedRealtimeSession(
  override?: EmbeddedRealtimeSessionClientOverride,
): EmbeddedClientContextValue<EmbeddedRealtimeSessionClientLike>;
export function useEmbeddedRealtimeSession(
  override?: EmbeddedRealtimeSessionClientOverride<ChatClient>,
): EmbeddedClientContextValue<EmbeddedRealtimeSessionClientLike<ChatClient>>;
export function useEmbeddedRealtimeSession(
  override: EmbeddedRealtimeSessionClientOverride<ChatClient> = {},
): EmbeddedClientContextValue<EmbeddedRealtimeSessionClientLike<ChatClient>> {
  // Preserve the existing lazy capability behavior: proxy/test clients may
  // implement only the methods reached by their selected model and lifecycle.
  // The exported structural type remains the complete embedding contract.
  return useEmbeddedClientRefinement(override, [], "realtime hooks");
}

/**
 * Resolve the client only — for hooks that are not workspace-scoped
 * (`useWorkspaces`, `useBillingUsage`).
 */
export function useOpenGeniClient(override?: Pick<ClientOverride, "client">): SessionClientLike;
export function useOpenGeniClient(
  override?: Pick<ClientOverride<ChatClient>, "client">,
): SessionClientLike<ChatClient>;
export function useOpenGeniClient(
  override: Pick<ClientOverride<ChatClient>, "client"> = {},
): SessionClientLike<ChatClient> {
  const context = useContext(OpenGeniContext);
  const client = override.client ?? context?.client;
  if (!client) {
    throw new Error(
      "@opengeni/react: no Opengeni client available. Wrap the tree in <OpenGeniProvider> or pass { client } to the hook.",
    );
  }
  return client;
}
