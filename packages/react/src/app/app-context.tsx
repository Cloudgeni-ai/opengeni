// The app-wide session state contract every session surface reads. The web
// app's root provider (context.tsx) supplies it; other hosts supply their own.
import type {
  CreateSessionRequest,
  McpConnectionAccountSelection,
  PersonalGitHubRepositorySelectionInput,
  SessionEvent,
} from "@opengeni/sdk";
import { type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { SessionEventsConnectionState } from "../hooks/use-session-events";
import {
  createContext,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useContext,
  useInsertionEffect,
  useRef,
} from "react";
import { type ManagedSelfContext } from "./lib/managed-self-context";
import type { SessionChannelProjectionAuthority } from "./lib/session-pins";
import {
  type IntelligenceEffort,
  type McpServerOption,
  type RepoDraft,
  type RepositoryGroup,
} from "./lib/session-tools";
import { type WorkspaceTransitionIdentity } from "./lib/workspace-transition";
import type {
  AccessContext,
  AuthSession,
  CapabilityCatalogItem,
  ClientConfig,
  CreateWorkspaceRequest,
  GitHubAppInfo,
  GitHubRepository,
  LatencyMode,
  ResourceRef,
  PersonalGitHubConnectionStatusResponse,
  PersonalGitHubRepositoryCatalogItem,
  PersonalGitHubRepositorySelectionState,
  Session,
  SlackUserLinkAccessRequest,
  ToolRef,
  TurnSubmission,
  UpdateWorkspaceSettingsRequest,
  Workspace,
} from "./types";

export type AppContextValue = {
  client: OpenGeniBrowserClient;
  clientConfig: ClientConfig;
  authSession: AuthSession | null;
  accessContext: AccessContext;
  workspaces: Workspace[];
  /** Exact managed-human membership facts bound to the current credential identity. */
  managedSelfContext: ManagedSelfContext | null;
  /** Token-free continuation identity retained across Root/provider remounts. */
  slackLinkContinuationWorkspaceId: string | null;
  /** Token-free initial-route marker for a rejected legacy query bearer. */
  invalidSlackLinkQueryWorkspaceId: string | null;
  /** Creates or joins the one server-side prepare request for the bootstrapped bearer. */
  preparePendingSlackLink: (workspaceId: string) => Promise<SlackUserLinkAccessRequest | null>;
  clearSlackLinkContinuation: () => void;
  accessKeyVersion: number;
  keyAuthRequired: boolean;
  model: string;
  setModel: Dispatch<SetStateAction<string>>;
  /** New-session composer effort. Established sessions own their policy in their draft. */
  reasoningEffort: IntelligenceEffort;
  setReasoningEffort: Dispatch<SetStateAction<IntelligenceEffort>>;
  /** New-session composer latency. Established sessions own their policy in their draft. */
  latencyMode: LatencyMode;
  setLatencyMode: Dispatch<SetStateAction<LatencyMode>>;
  inspectorOpen: boolean;
  setInspectorOpen: Dispatch<SetStateAction<boolean>>;
  session: Session | null;
  setSession: Dispatch<SetStateAction<Session | null>>;
  /** Browser-only ownership of list/point-read channel projections. */
  sessionChannelProjectionAuthority: SessionChannelProjectionAuthority;
  /**
   * Exact successful create result carried across the index -> session route.
   * It keeps the accepted first prompt visible while the durable event tail
   * catches up, without treating ordinary follow-ups as direct-chat sends.
   */
  sessionCreationHandoff: SessionCreationHandoff | null;
  connectionState: SessionEventsConnectionState;
  setConnectionState: Dispatch<SetStateAction<SessionEventsConnectionState>>;
  /** The routed session's one shared event feed. Header consumers must never self-stream. */
  sessionEventFeedStore: SessionEventFeedStore;
  manualRepos: RepoDraft[];
  setManualRepos: Dispatch<SetStateAction<RepoDraft[]>>;
  manualReposOpen: boolean;
  setManualReposOpen: Dispatch<SetStateAction<boolean>>;
  selectedRepoIds: Set<number>;
  setSelectedRepoIds: Dispatch<SetStateAction<Set<number>>>;
  selectedRepoRefs: Record<number, string>;
  setSelectedRepoRefs: Dispatch<SetStateAction<Record<number, string>>>;
  githubRepos: GitHubRepository[];
  githubStatus: GitHubAppInfo | null;
  /** True when the last GitHub status/catalog fetch failed (unknown, not unbound). */
  githubStatusFailed: boolean;
  /** True once the current workspace's repository catalog has completed its first load. */
  githubCatalogReady: boolean;
  personalGitHubStatus: PersonalGitHubConnectionStatusResponse | null;
  personalGitHubRepositories: PersonalGitHubRepositoryCatalogItem[];
  personalGitHubSelection: PersonalGitHubRepositorySelectionState | null;
  personalGitHubCatalogReady: boolean;
  personalGitHubBusy: boolean;
  selectedPersonalGitHubRepoIds: Set<string>;
  setSelectedPersonalGitHubRepoIds: Dispatch<SetStateAction<Set<string>>>;
  selectedPersonalGitHubRepoRefs: Record<string, string>;
  setSelectedPersonalGitHubRepoRefs: Dispatch<SetStateAction<Record<string, string>>>;
  personalGitHubAuthority: McpConnectionAccountSelection | null;
  githubAppOpen: boolean;
  setGithubAppOpen: Dispatch<SetStateAction<boolean>>;
  githubOrg: string;
  setGithubOrg: Dispatch<SetStateAction<string>>;
  selectedCapabilityToolIds: Set<string>;
  setSelectedCapabilityToolIds: Dispatch<SetStateAction<Set<string>>>;
  busy: boolean;
  repoBusy: boolean;
  githubAppBusy: boolean;
  selectedInstallationId: number | null;
  repositoryGroups: RepositoryGroup[];
  toolMcpServers: McpServerOption[];
  /** Capability MCP servers currently enabled as the workspace default. */
  workspaceDefaultToolIds: string[];
  /** True once the workspace capability catalog has completed its authoritative load. */
  workspaceMcpCatalogReady: boolean;
  /** Failed or pending reads must never remove a saved tool selection. */
  workspaceMcpCatalogLoadedSuccessfully: boolean;
  /** The authoritative workspace catalog, shared by tool policy and timeline presentation. */
  workspaceCapabilityCatalog: CapabilityCatalogItem[];
  currentResources: ResourceRef[];
  repositoryValidationError: string | null;
  /**
   * Workspace whose mutable console state is currently safe to render.
   * This is a display fence only; server access grants remain authoritative.
   */
  workspaceStateOwnerId: string | null;
  /** Clear and rebind every workspace/session-local draft and cache before display. */
  prepareWorkspaceTransition: (workspaceId: string) => void;
  /** Capture the exact routed workspace/principal transition for one async invocation. */
  captureWorkspaceInvocation: (workspaceId: string) => WorkspaceTransitionIdentity | null;
  /** True only while an invocation still owns the routed workspace/principal UI. */
  ownsWorkspaceInvocation: (workspaceId: string, accepted: WorkspaceTransitionIdentity) => boolean;
  addManualRepository: () => void;
  forgetAccessKey: () => void;
  handleManagedSignOut: () => Promise<void>;
  /** Reload grants, workspaces, and managed self-membership from the cookie. */
  revalidatePrincipalAccess: () => void;
  /** Refreshes the current principal's organization and workspace grants in place. */
  refreshPrincipalAccess: () => Promise<boolean>;
  createWorkspace: (request: CreateWorkspaceRequest) => Promise<Workspace | null>;
  renameWorkspace: (workspaceId: string, name: string) => Promise<Workspace | null>;
  setWorkspaceInferenceControl: (
    workspaceId: string,
    action: "pause" | "resume",
  ) => Promise<boolean>;
  refreshWorkspace: (workspaceId: string) => Promise<void>;
  updateWorkspaceSettings: (
    workspaceId: string,
    settings: UpdateWorkspaceSettingsRequest,
  ) => Promise<Workspace | null>;
  /** Set (or clear, with `null`) the workspace's default rig — used by session
   * create fallback. Upserts the returned workspace so the "Default" badge and
   * any default-derived UI reflect it without a reload. */
  setWorkspaceDefaultRig: (workspaceId: string, rigId: string | null) => Promise<Workspace | null>;
  updateSessionTitle: (
    workspaceId: string,
    sessionId: string,
    title: string,
  ) => Promise<Session | null>;
  /** Optimistically set the current member's personal session pin. */
  updateSessionPin: (
    workspaceId: string,
    sessionId: string,
    pinned: boolean,
    expectedVersion?: number,
  ) => Promise<Session | null>;
  deleteWorkspace: (workspaceId: string) => Promise<boolean>;
  refreshGitHub: (
    workspaceId: string,
    signal?: AbortSignal,
    options?: { sync?: boolean | undefined },
  ) => Promise<void>;
  refreshPersonalGitHub: (workspaceId: string, signal?: AbortSignal) => Promise<void>;
  connectPersonalGitHub: (workspaceId: string) => Promise<void>;
  reconnectPersonalGitHub: (workspaceId: string) => Promise<void>;
  disconnectPersonalGitHub: (workspaceId: string) => Promise<boolean>;
  savePersonalGitHubRepositories: (
    workspaceId: string,
    repositories: PersonalGitHubRepositorySelectionInput[],
  ) => Promise<boolean>;
  ensurePersonalGitHubAuthority: (
    workspaceId: string,
  ) => Promise<McpConnectionAccountSelection | null>;
  togglePersonalGitHubRepository: (
    workspaceId: string,
    repository: PersonalGitHubRepositoryCatalogItem,
  ) => Promise<void>;
  refreshWorkspaceMcpServers: (workspaceId: string, signal?: AbortSignal) => Promise<void>;
  startGitHubAppManifestFlow: (workspaceId: string) => Promise<void>;
  /** Resolves true when the unlink succeeded; failures self-toast and resolve false. */
  disconnectGitHubInstallation: (workspaceId: string, installationId: number) => Promise<boolean>;
  toggleGitHubRepository: (repo: GitHubRepository) => void;
  startSession: (
    workspaceId: string,
    submission: TurnSubmission,
    options?: {
      instructions?: string | undefined;
      /** Installed session-selected Skills to freeze onto this exact session. */
      installedSkillIds?: string[] | undefined;
      /** Exact session MCP policy. Omit to use the product UI's workspace selection. */
      sessionTools?: ToolRef[] | undefined;
      newSessionDraftToolPolicy?:
        | {
            tools: ToolRef[];
            toolsProvided: boolean;
            excludedMcpServerIds?: string[] | undefined;
          }
        | undefined;
      targetSandboxId?: string | null | undefined;
      workingDir?: string | null | undefined;
      /** Workspace folder to file the new session under. */
      channelId?: string | null | undefined;
      omitWorkspaceResources?: boolean | undefined;
      expectedNewSessionDraftRevision?: number | undefined;
      agentLearning?: import("@opengeni/sdk").AgentLearningOverrides | undefined;
      /** Create a session shell without starting an underlying agent turn. */
      startMode?: "realtime" | undefined;
      /** Atomic create-time session visibility. */
      visibility?: "private" | "workspace" | undefined;
      /** Create-time per-task usage limit (USD micros); omit for no limit. */
      usageLimitMicros?: number | null | undefined;
      /** Exact attempted request and classified outcome for host reconciliation. */
      /** Return true when the caller handles this failure (including its user-facing error). */
      onFailure?: ((failure: StartSessionFailure) => boolean | void) | undefined;
    },
  ) => Promise<Session | null>;
  resetSessionView: () => void;
  resetWorkspaceIntegrations: () => void;
};

export type SessionCreationHandoff = Readonly<{
  session: Session;
  clientEventId: string;
}>;

export type PendingSlackLink = {
  workspaceId: string;
  token: string;
};

export type StartSessionFailure = Readonly<{
  error: Error;
  request: CreateSessionRequest;
  outcomeUnknown: boolean;
}>;

export type SessionEventFeed = { sessionId: string; events: SessionEvent[] } | null;

export type SessionEventFeedStore = {
  getSnapshot: () => SessionEventFeed;
  subscribe: (listener: () => void) => () => void;
  set: (feed: SessionEventFeed) => void;
};

export function createSessionEventFeedStore(): SessionEventFeedStore {
  let snapshot: SessionEventFeed = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (feed) => {
      if (snapshot === feed) return;
      snapshot = feed;
      for (const listener of listeners) listener();
    },
  };
}

export const AppContext = createContext<AppContextValue | null>(null);

/** Stable event identity that dispatches only to the latest committed body. */
export function useLatestCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  // Insertion effects run at commit before descendant layout effects can invoke
  // an event. A suspended/abandoned render therefore cannot leak its body.
  useInsertionEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

/** The app context where one exists; null in hosts that render a piece of the app alone. */
export function useOptionalAppContext(): AppContextValue | null {
  return useContext(AppContext);
}

export function useAppContext(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error("Opengeni app context is not ready");
  }
  return value;
}

export function workspaceLabel(workspace: Workspace, workspaces: Workspace[]): string {
  const hasMultipleAccounts = new Set(workspaces.map((candidate) => candidate.accountId)).size > 1;
  if (!hasMultipleAccounts) {
    return workspace.name;
  }
  return `${workspace.name} / ${workspace.accountId.slice(0, 8)}`;
}
