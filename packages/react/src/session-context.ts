import type {
  StreamConnectionState,
  WorkspaceControlEvent,
  WorkspaceInteractionRevisionEvent,
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

export type OpenGeniContextValue = {
  client: SessionClientLike;
  workspaceId: string;
  workspaceControlEvent: WorkspaceControlEvent | null;
  workspaceControlConnectionState: StreamConnectionState | "idle" | "error";
  workspaceInteractionEvent: WorkspaceInteractionRevisionEvent | null;
  workspaceInteractionConnectionState: StreamConnectionState | "idle" | "error";
  registerSessionReconciler: (
    sessionId: string,
    key: string,
    reconcile: () => Promise<void>,
  ) => () => void;
  reconcileSession: (sessionId: string) => Promise<void>;
};

export const OpenGeniContext = createContext<OpenGeniContextValue | null>(null);

const NOOP_REGISTER_RECONCILER: OpenGeniContextValue["registerSessionReconciler"] = () => () =>
  undefined;
const NOOP_RECONCILE_SESSION: OpenGeniContextValue["reconcileSession"] = async () => undefined;

export type ClientOverride = {
  client?: SessionClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedSessionClientOverride = {
  client?: EmbeddedSessionClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedHumanInputClientOverride = {
  client?: EmbeddedHumanInputSessionClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedSessionMcpApprovalPolicyClientOverride = {
  client?: EmbeddedSessionMcpApprovalPolicyClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedSessionReadClientOverride = {
  client?: EmbeddedSessionReadClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedRealtimeSessionClientOverride = {
  client?: EmbeddedRealtimeSessionClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedGoalClientOverride = {
  client?: EmbeddedGoalClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedSessionLineageClientOverride = {
  client?: EmbeddedSessionLineageClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedFileAttachmentClientOverride = {
  client?: EmbeddedFileAttachmentClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedInteractionClientOverride = {
  client?: EmbeddedInteractionClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedInterventionClientOverride = {
  client?: EmbeddedInterventionClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedBrowserInteractionClientOverride = {
  client?: EmbeddedBrowserInteractionClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedComputerInteractionClientOverride = {
  client?: EmbeddedComputerInteractionClientLike | undefined;
  workspaceId?: string | undefined;
};

export type EmbeddedSessionContextValue = Omit<OpenGeniContextValue, "client"> & {
  client: EmbeddedSessionClientLike;
};

type EmbeddedClientOverride<TClient> = {
  client?: TClient | undefined;
  workspaceId?: string | undefined;
};

type EmbeddedClientContextValue<TClient> = Omit<OpenGeniContextValue, "client"> & {
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
      "@opengeni/react: no OpenGeni client/workspace available. Wrap the tree in <OpenGeniProvider> or pass { client, workspaceId } to the hook.",
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
export function useOpenGeni(override: ClientOverride = {}): OpenGeniContextValue {
  const context = useContext(OpenGeniContext);
  const client = override.client ?? context?.client;
  const workspaceId = override.workspaceId ?? context?.workspaceId;
  if (!client || !workspaceId) {
    throw new Error(
      "@opengeni/react: no OpenGeni client/workspace available. Wrap the tree in <OpenGeniProvider> or pass { client, workspaceId } to the hook.",
    );
  }
  return {
    client,
    workspaceId,
    workspaceControlEvent: context?.workspaceControlEvent ?? null,
    workspaceControlConnectionState: context?.workspaceControlConnectionState ?? "idle",
    workspaceInteractionEvent: context?.workspaceInteractionEvent ?? null,
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
  "protectedBrowserAuthFill",
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
  override: EmbeddedInterventionClientOverride = {},
): EmbeddedClientContextValue<EmbeddedInterventionClientLike> {
  return useEmbeddedClientRefinement(
    override,
    INTERVENTION_METHODS,
    "interaction intervention hooks",
  );
}

/** Resolve only BrowserSession methods for a standalone Browser embed. */
export function useEmbeddedBrowserInteraction(
  override: EmbeddedBrowserInteractionClientOverride = {},
): EmbeddedClientContextValue<EmbeddedBrowserInteractionClientLike> {
  return useEmbeddedClientRefinement(
    override,
    BROWSER_INTERACTION_METHODS,
    "browser interaction hooks",
  );
}

/** Resolve only ComputerSession methods for a standalone Computer embed. */
export function useEmbeddedComputerInteraction(
  override: EmbeddedComputerInteractionClientOverride = {},
): EmbeddedClientContextValue<EmbeddedComputerInteractionClientLike> {
  return useEmbeddedClientRefinement(
    override,
    COMPUTER_INTERACTION_METHODS,
    "computer interaction hooks",
  );
}

/** Resolve the complete Browser + Computer client surface. */
export function useEmbeddedInteraction(
  override: EmbeddedInteractionClientOverride = {},
): EmbeddedClientContextValue<EmbeddedInteractionClientLike> {
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
  override: EmbeddedSessionClientOverride = {},
): EmbeddedSessionContextValue {
  return useEmbeddedClientRefinement(
    override,
    [
      "getSession",
      "listEvents",
      "streamEvents",
      "getComposerDraft",
      "saveComposerDraft",
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
  override: EmbeddedSessionReadClientOverride = {},
): EmbeddedClientContextValue<EmbeddedSessionReadClientLike> {
  return useEmbeddedClientRefinement(
    override,
    eventClientMethods(override, ["getSession", "updateSession"]),
    "useSession",
  );
}

/** Resolve the exact client surface required by `useGoal`. */
export function useEmbeddedGoal(
  override: EmbeddedGoalClientOverride = {},
): EmbeddedClientContextValue<EmbeddedGoalClientLike> {
  return useEmbeddedClientRefinement(
    override,
    eventClientMethods(override, ["getGoal", "updateGoal", "deleteGoal"]),
    "useGoal",
  );
}

/** Resolve the exact client surface required by `useSessionLineage`. */
export function useEmbeddedSessionLineage(
  override: EmbeddedSessionLineageClientOverride = {},
): EmbeddedClientContextValue<EmbeddedSessionLineageClientLike> {
  return useEmbeddedClientRefinement(
    override,
    eventClientMethods(override, ["getSessionLineage"]),
    "useSessionLineage",
  );
}

/** Resolve the exact client surface required by `useFileAttachments`. */
export function useEmbeddedFileAttachments(
  override: EmbeddedFileAttachmentClientOverride = {},
): EmbeddedClientContextValue<EmbeddedFileAttachmentClientLike> {
  return useEmbeddedClientRefinement(override, ["uploadFile"], "useFileAttachments");
}

/**
 * Resolve the structured-input refinement without widening the baseline
 * session-only proxy contract.
 */
export function useEmbeddedHumanInputSession(override: EmbeddedHumanInputClientOverride = {}): Omit<
  EmbeddedSessionContextValue,
  "client"
> & {
  client: EmbeddedHumanInputSessionClientLike;
} {
  return useEmbeddedClientRefinement(
    override,
    eventClientMethods(override, ["listHumanInputRequests", "submitHumanInputResponse"]),
    "useHumanInputRequests",
  );
}

/** Resolve the approval-policy refinement without widening session-only hosts. */
export function useEmbeddedSessionMcpApprovalPolicy(
  override: EmbeddedSessionMcpApprovalPolicyClientOverride = {},
): Omit<EmbeddedSessionContextValue, "client"> & {
  client: EmbeddedSessionMcpApprovalPolicyClientLike;
} {
  return useEmbeddedClientRefinement(
    override,
    eventClientMethods(override, ["getSession", "updateSessionMcpApprovalPolicy"]),
    "useSessionMcpApprovalPolicy",
  );
}

/** Resolve the exact browser/API surface required by `@opengeni/react/realtime`. */
export function useEmbeddedRealtimeSession(
  override: EmbeddedRealtimeSessionClientOverride = {},
): EmbeddedClientContextValue<EmbeddedRealtimeSessionClientLike> {
  // Preserve the existing lazy capability behavior: proxy/test clients may
  // implement only the methods reached by their selected model and lifecycle.
  // The exported structural type remains the complete embedding contract.
  return useEmbeddedClientRefinement(override, [], "realtime hooks");
}

/**
 * Resolve the client only — for hooks that are not workspace-scoped
 * (`useWorkspaces`, `useBillingUsage`).
 */
export function useOpenGeniClient(
  override: Pick<ClientOverride, "client"> = {},
): SessionClientLike {
  const context = useContext(OpenGeniContext);
  const client = override.client ?? context?.client;
  if (!client) {
    throw new Error(
      "@opengeni/react: no OpenGeni client available. Wrap the tree in <OpenGeniProvider> or pass { client } to the hook.",
    );
  }
  return client;
}
