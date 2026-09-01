// Root providers: client config bootstrap, auth (deployment key / configured
// token / managed session), workspace access, and the cross-route console
// state (model choice, repo selection, tool toggles). Everything below the
// workspace shell consumes this through `useAppContext`.
import {
  resolveWorkspaceSessionDefaults,
  resolveWorkspaceSessionToolDefaults,
} from "@opengeni/contracts";
import type {
  CreateSessionRequest,
  McpConnectionAuthoritySelection,
  PersonalGitHubRepositorySelectionInput,
  SessionEvent,
} from "@opengeni/sdk";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { composerSubmissionErrorMessage, type SessionEventsConnectionState } from "@opengeni/react";
import type { BrowserAccountTransition } from "@opengeni/react/accounts";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { CheckIcon, LockIcon } from "lucide-react";
import {
  createContext,
  lazy,
  Suspense,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";

import {
  clearStoredAccessKey,
  configureManagedActorEpoch,
  createOpenGeniClient,
  fetchAuthSession,
  fetchClientConfig,
  getStoredAccessKey,
  setStoredAccessKey,
  signInEmail,
  signOutManaged,
  signUpEmail,
  startManagedSocialSignIn,
} from "@/api";
import { LoadingPanel, ProblemPanel } from "@/components/common";
import { OrganizationOnboardingPanel } from "@/components/organization-onboarding-panel";
import { SecureContextWarning } from "@/components/secure-context-warning";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toaster } from "@/components/ui/sonner";
import type { AnalyticsEventName, AnalyticsProperties } from "@/lib/analytics";
import { ManagedAuthSessionUnavailableError } from "@/lib/managed-auth-form";
import { signOutWithAuthoritativeReconciliation } from "@/lib/managed-auth-transition";
import {
  loadCurrentManagedSelfContext,
  managedSelfContextIdentity,
  type ManagedSelfContext,
  type ManagedSelfContextIdentity,
} from "@/lib/managed-self-context";
import { sameSessionForContext } from "@/lib/session-context";
import { runSingleFlight } from "@/lib/single-flight";
import {
  buildCreateSessionRequest,
  classifyCreateSessionFailure,
  prepareCreateSessionAttempt,
  retainCreateSessionAttemptAfterFailure,
  type PendingCreateAttempt,
} from "@/lib/session-create";
import {
  applySessionPinProjection,
  notifySessionPinChanged,
  reconcileFailedSessionPin,
  SessionChannelProjectionAuthority,
} from "@/lib/session-pins";
import {
  buildResources,
  buildOpenGeniUiTools,
  enabledWorkspaceCapabilityMcpServers,
  groupRepositories,
  initialReasoningEffort,
  installedApiIntegrationMcpServers,
  isAbortError,
  mergeMcpServerOptions,
  selectableMcpServers,
  selectedAvailableCapabilityToolIds,
  type IntelligenceEffort,
  type McpServerOption,
  type RepoDraft,
  type RepositoryGroup,
} from "@/lib/session-tools";
import { upsertWorkspace } from "@/lib/workspaces";
import {
  beginWorkspaceOperation,
  beginWorkspaceTransition,
  invalidatePrincipalTransition,
  invalidateWorkspaceTransition,
  ownsPrincipalTransition,
  ownsTransitionInvocation,
  ownsWorkspaceOperation,
  ownsWorkspaceTransition,
  runCurrentWorkspaceOperation,
  runCurrentWorkspaceRequest,
  runCurrentTransitionInvocation,
  settleWorkspaceOperation,
  type PrincipalTransitionIdentity,
  type WorkspaceOperationIdentity,
  type WorkspaceTransitionIdentity,
} from "@/lib/workspace-transition";
import {
  reusablePersonalGitHubAuthority,
  type PersonalGitHubAuthorityCache,
} from "@/lib/personal-github-authority";
import type {
  AccessContext,
  AuthSession,
  CapabilityCatalogItem,
  CapabilityCatalogResponse,
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
} from "@/types";

const AnalyticsManager = lazy(() =>
  import("@/components/analytics-consent").then((module) => ({
    default: module.AnalyticsManager,
  })),
);

const ManagedAuthPanel = lazy(() =>
  import("@/components/managed-auth-panel").then((module) => ({
    default: module.ManagedAuthPanel,
  })),
);

const BrowserAccountsRuntime = lazy(() =>
  import("@/components/browser-accounts-runtime").then((module) => ({
    default: module.BrowserAccountsRuntime,
  })),
);

const BrowserAccountsSignedOutPanel = lazy(() =>
  import("@/components/browser-accounts-runtime").then((module) => ({
    default: module.BrowserAccountsSignedOutPanel,
  })),
);

const BrowserAccountsLoadingGate = lazy(() =>
  import("@/components/browser-accounts-runtime").then((module) => ({
    default: module.BrowserAccountsLoadingGate,
  })),
);

function captureProductAnalyticsEvent(
  name: AnalyticsEventName,
  properties: AnalyticsProperties = {},
): void {
  void import("@/lib/analytics").then(({ captureAnalyticsEvent }) => {
    captureAnalyticsEvent(name, properties);
  });
}

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
  personalGitHubAuthority: McpConnectionAuthoritySelection | null;
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
  /** The authoritative workspace catalog, shared by tool policy and timeline presentation. */
  workspaceCapabilityCatalog: CapabilityCatalogItem[];
  currentResources: ResourceRef[];
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
    options?: { sync?: boolean },
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
    context?: "user_private" | "workspace_shared",
  ) => Promise<McpConnectionAuthoritySelection | null>;
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
      instructions?: string;
      /** Exact session MCP policy. Omit to use the product UI's workspace selection. */
      sessionTools?: ToolRef[];
      targetSandboxId?: string | null;
      workingDir?: string | null;
      /** Workspace folder to file the new session under. */
      channelId?: string | null;
      omitWorkspaceResources?: boolean;
      expectedNewSessionDraftRevision?: number;
      /** Create a session shell without starting an underlying agent turn. */
      startMode?: "realtime";
      /** Atomic create-time session visibility. */
      visibility?: "private" | "workspace";
      /** Exact attempted request and classified outcome for host reconciliation. */
      onFailure?: (failure: StartSessionFailure) => void;
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

export type SlackLinkPreparePhase = "none" | "raw" | "in_flight" | "prepared" | "failed";

/**
 * A signed-out Slack deep link has already been scrubbed from browser history,
 * so its raw in-memory bearer may cross exactly the sign-in that authenticates
 * its exchange. Every other principal transition clears it.
 */
export function preserveSlackLinkForManagedAuth(
  mode: "signin" | "signup",
  phase: SlackLinkPreparePhase,
): boolean {
  return mode === "signin" && phase === "raw";
}

export function createSlackLinkPrepareController<Request>(value: PendingSlackLink | null) {
  let workspaceId = value?.workspaceId ?? null;
  let bearer = value?.token ?? null;
  let inFlight: Promise<Request> | null = null;
  let prepared: Request | null = null;
  let failure: unknown;
  let hasFailure = false;
  let generation = 0;

  return {
    workspaceId: () => workspaceId,
    phase: (): SlackLinkPreparePhase => {
      if (!workspaceId) return "none";
      if (bearer !== null) return "raw";
      if (inFlight) return "in_flight";
      if (prepared !== null) return "prepared";
      return hasFailure ? "failed" : "none";
    },
    prepare: (
      requestedWorkspaceId: string,
      exchange: (token: string) => Promise<Request>,
    ): Promise<Request | null> => {
      if (!workspaceId || requestedWorkspaceId !== workspaceId) return Promise.resolve(null);
      if (prepared !== null) return Promise.resolve(prepared);
      if (hasFailure) return Promise.reject(failure);
      if (inFlight) return inFlight;
      if (bearer === null) return Promise.resolve(null);

      const token = bearer;
      const claimedGeneration = generation;
      let exchangePromise: Promise<Request>;
      try {
        exchangePromise = exchange(token);
      } catch (error) {
        exchangePromise = Promise.reject(error);
      }
      // The exchange request now owns the only live bearer reference. Module,
      // React, URL, history, and storage state retain only token-free facts.
      bearer = null;
      let flight: Promise<Request>;
      flight = exchangePromise
        .then(
          (request) => {
            if (generation === claimedGeneration) prepared = request;
            return request;
          },
          (error: unknown) => {
            if (generation === claimedGeneration) {
              failure = error;
              hasFailure = true;
            }
            throw error;
          },
        )
        .finally(() => {
          if (generation === claimedGeneration && inFlight === flight) inFlight = null;
        });
      inFlight = flight;
      return flight;
    },
    clear: () => {
      generation += 1;
      workspaceId = null;
      bearer = null;
      inFlight = null;
      prepared = null;
      failure = undefined;
      hasFailure = false;
    },
  };
}

// Capture and scrub the signed fragment while this module is loading, before
// TanStack Router canonicalizes the initial location. The module-scoped
// controller survives Root/provider remounts, but releases the raw bearer as
// soon as exactly one prepare request has been created.
const bootstrappedPendingSlackLink = pendingSlackLinkFromBrowserLocation();
const bootstrappedInvalidSlackLinkQueryWorkspaceId =
  typeof window === "undefined"
    ? null
    : invalidSlackLinkQueryWorkspaceIdFromUrl(window.location.href);
stripSlackLinkFromBrowserLocation();
const slackLinkPrepareController = createSlackLinkPrepareController<SlackUserLinkAccessRequest>(
  bootstrappedPendingSlackLink,
);

type SessionEventFeed = { sessionId: string; events: SessionEvent[] } | null;

type SessionEventFeedStore = {
  getSnapshot: () => SessionEventFeed;
  subscribe: (listener: () => void) => () => void;
  set: (feed: SessionEventFeed) => void;
};

function createSessionEventFeedStore(): SessionEventFeedStore {
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

const AppContext = createContext<AppContextValue | null>(null);

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

export function useAppContext(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error("OpenGeni app context is not ready");
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

export function RootRouteComponent() {
  const [session, setSessionState] = useState<Session | null>(null);
  const [sessionChannelProjectionAuthority] = useState(
    () => new SessionChannelProjectionAuthority(),
  );
  const [sessionCreationHandoff, setSessionCreationHandoff] =
    useState<SessionCreationHandoff | null>(null);
  const [clientConfig, setClientConfig] = useState<ClientConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [authSession, setAuthSession] = useState<AuthSession | null | undefined>(undefined);
  const [managedAuthBootstrapComplete, setManagedAuthBootstrapComplete] = useState(false);
  const [accessContext, setAccessContext] = useState<AccessContext | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [managedSelfContext, setManagedSelfContext] = useState<ManagedSelfContext | null>(null);
  const [slackLinkContinuationWorkspaceId, setSlackLinkContinuationWorkspaceId] = useState<
    string | null
  >(slackLinkPrepareController.workspaceId);
  const [invalidSlackLinkQueryWorkspaceId, setInvalidSlackLinkQueryWorkspaceId] = useState<
    string | null
  >(bootstrappedInvalidSlackLinkQueryWorkspaceId);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [model, setModel] = useState("gpt-5.6-sol");
  const [reasoningEffort, setReasoningEffort] = useState<IntelligenceEffort>("low");
  const [latencyMode, setLatencyMode] = useState<LatencyMode>("standard");
  // Changes/Files dock starts collapsed; user opens via the session-panel toggle.
  // No localStorage — only an in-memory default (toggle still works for the session).
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [connectionState, setConnectionState] = useState<SessionEventsConnectionState>("idle");
  const [sessionEventFeedStore] = useState(createSessionEventFeedStore);
  const [manualRepos, setManualRepos] = useState<RepoDraft[]>([]);
  const [manualReposOpen, setManualReposOpen] = useState(false);
  const [nextRepoId, setNextRepoId] = useState(1);
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<number>>(() => new Set());
  const [selectedRepoRefs, setSelectedRepoRefs] = useState<Record<number, string>>({});
  const [githubRepos, setGithubRepos] = useState<GitHubRepository[]>([]);
  const [githubStatus, setGithubStatus] = useState<GitHubAppInfo | null>(null);
  const [githubStatusFailed, setGithubStatusFailed] = useState(false);
  const [githubCatalogReady, setGithubCatalogReady] = useState(false);
  const [personalGitHubStatus, setPersonalGitHubStatus] =
    useState<PersonalGitHubConnectionStatusResponse | null>(null);
  const [personalGitHubRepositories, setPersonalGitHubRepositories] = useState<
    PersonalGitHubRepositoryCatalogItem[]
  >([]);
  const [personalGitHubSelection, setPersonalGitHubSelection] =
    useState<PersonalGitHubRepositorySelectionState | null>(null);
  const [personalGitHubCatalogReady, setPersonalGitHubCatalogReady] = useState(false);
  const [personalGitHubBusy, setPersonalGitHubBusy] = useState(false);
  const [selectedPersonalGitHubRepoIds, setSelectedPersonalGitHubRepoIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedPersonalGitHubRepoRefs, setSelectedPersonalGitHubRepoRefs] = useState<
    Record<string, string>
  >({});
  const [personalGitHubAuthorityCache, setPersonalGitHubAuthorityCache] =
    useState<PersonalGitHubAuthorityCache | null>(null);
  const personalGitHubAuthority = personalGitHubAuthorityCache?.authority ?? null;
  const [githubAppOpen, setGithubAppOpen] = useState(false);
  const [githubOrg, setGithubOrg] = useState("");
  const [workspaceMcpServers, setWorkspaceMcpServers] = useState<McpServerOption[]>([]);
  const [workspaceCapabilityCatalog, setWorkspaceCapabilityCatalog] = useState<
    CapabilityCatalogItem[]
  >([]);
  const [workspaceMcpCatalogReady, setWorkspaceMcpCatalogReady] = useState(false);
  const [selectedCapabilityToolIds, setSelectedCapabilityToolIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [workspaceStateOwnerId, setWorkspaceStateOwnerId] = useState<string | null>(null);
  const workspaceTransitionIdentity = useRef<WorkspaceTransitionIdentity>({
    workspaceId: null,
    revision: 0,
  });
  const principalTransitionIdentity = useRef<PrincipalTransitionIdentity>({
    revision: 0,
  });
  const workspaceOperationSequence = useRef(0);
  const activeCreateOperation = useRef<WorkspaceOperationIdentity | null>(null);
  const githubManifestOperationSequence = useRef(0);
  const activeGitHubManifestOperation = useRef<WorkspaceOperationIdentity | null>(null);
  const githubDisconnectOperationSequence = useRef(0);
  const activeGitHubDisconnectOperation = useRef<WorkspaceOperationIdentity | null>(null);
  const authPrincipalIdRef = useRef<string | null>(null);
  const accessPrincipalIdRef = useRef<string | null>(null);
  const managedSelfContextIdentityRef = useRef<ManagedSelfContextIdentity | null>(null);
  // Every available tool is selected when it first appears. Explicit
  // deselections survive subsequent catalog refreshes.
  const previousCapabilityToolIds = useRef<Set<string>>(new Set());
  const githubRefreshId = useRef(0);
  const personalGitHubRefreshId = useRef(0);
  const mcpRefreshId = useRef(0);
  const mcpCatalogRequests = useRef(new Map<string, Promise<CapabilityCatalogResponse>>());
  // Stable CREATE idempotency key for the in-flight session create. Generated
  // lazily and reused across retries (and across a double-click that re-enters
  // startSession before busy flips), so duplicate creates collapse to one
  // session server-side; retained only while the mutation outcome is unknown
  // and cleared on success or a definitive failure so a corrected request gets
  // a fresh key. Distinct from the per-call
  // clientEventId (a fresh UUID every send).
  const pendingCreateAttempt = useRef<PendingCreateAttempt | null>(null);
  const appliedWorkspaceSessionDefaultsKey = useRef<string | null>(null);
  const appliedWorkspaceToolDefaultsKey = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [repoBusy, setRepoBusy] = useState(false);
  const [githubAppBusy, setGithubAppBusy] = useState(false);
  const [hasAccessKey, setHasAccessKey] = useState(() => getStoredAccessKey() !== null);
  const [accessKeyDraft, setAccessKeyDraft] = useState("");
  const [accessKeyVersion, setAccessKeyVersion] = useState(0);
  const keyAuthRequired =
    clientConfig?.auth.mode === "deploymentKey" || clientConfig?.auth.mode === "configuredToken";
  const managedAuthRequired = clientConfig?.auth.mode === "managedSession";
  const browserAccountsConfigured =
    managedAuthRequired && clientConfig?.managedAuthSessionSetMode !== "legacy";
  const browserAccountsEnabled = browserAccountsConfigured && managedAuthBootstrapComplete;
  const managedEmailVerificationRequired =
    clientConfig?.auth.mode === "managedSession"
      ? (clientConfig.auth.emailVerificationRequired ?? true)
      : true;
  const managedSocialProviders =
    clientConfig?.auth.mode === "managedSession" ? (clientConfig.auth.socialProviders ?? []) : [];
  const keyAuthReady = !keyAuthRequired || hasAccessKey;
  const managedAuthReady = !managedAuthRequired || Boolean(authSession);
  const authReady = keyAuthReady && managedAuthReady;
  const defaultWorkspaceId =
    accessContext?.defaultWorkspaceId ??
    workspaces[0]?.id ??
    accessContext?.workspaceGrants[0]?.workspaceId ??
    null;
  const navigate = useNavigate();

  // Public routes render ahead of every auth/config gate: a user completing a
  // password reset is signed out by definition, so `/reset-password` must never
  // be intercepted by the sign-in panel or workspace-access loading.
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const hasSearchParameters = useRouterState({
    select: (state) => Object.keys(state.location.search).length > 0,
  });
  // Public surfaces render ahead of auth/config gates. `/reset-password` is
  // always public; DEV visual harnesses are public and need no session.
  const isPublicDevHarness =
    import.meta.env.DEV &&
    (pathname === "/dev/composer-chrome" ||
      pathname === "/dev/agent-topology" ||
      pathname === "/dev/onboarding");
  const isPublicAuthRoute =
    pathname === "/reset-password" ||
    pathname === "/setup-account" ||
    pathname === "/account-auth" ||
    isPublicDevHarness;
  useEffect(() => {
    if (!browserAccountsConfigured) configureManagedActorEpoch(null);
    return () => configureManagedActorEpoch(null);
  }, [browserAccountsConfigured]);
  useEffect(() => {
    if (
      invalidSlackLinkQueryWorkspaceId &&
      pathname !==
        `/workspaces/${encodeURIComponent(invalidSlackLinkQueryWorkspaceId)}/capabilities`
    ) {
      setInvalidSlackLinkQueryWorkspaceId(null);
    }
  }, [invalidSlackLinkQueryWorkspaceId, pathname]);
  // The @opengeni/sdk client behind every console API call and hook. Auth
  // headers are read per request; a new identity per key version makes the
  // hooks re-fetch and the event streams reconnect with the new credentials.
  const client = useMemo(() => {
    // The version is an explicit identity fence: credentials are read lazily,
    // but consumers need a new client object to reconnect hooks and streams.
    void accessKeyVersion;
    return createOpenGeniClient(sessionChannelProjectionAuthority.beginRead);
  }, [accessKeyVersion, sessionChannelProjectionAuthority]);
  const setSession = useCallback<Dispatch<SetStateAction<Session | null>>>((value) => {
    setSessionState((current) => {
      const next =
        typeof value === "function"
          ? (value as (previous: Session | null) => Session | null)(current)
          : value;
      return sameSessionForContext(current, next) ? current : next;
    });
  }, []);

  const resetSessionView = useCallback(() => {
    setSession(null);
    setSessionCreationHandoff(null);
    setConnectionState("idle");
    sessionEventFeedStore.set(null);
  }, [sessionEventFeedStore, setSession]);

  const resetWorkspaceIntegrations = useCallback(() => {
    setGithubStatus(null);
    setGithubStatusFailed(false);
    setGithubRepos([]);
    setGithubCatalogReady(false);
    setPersonalGitHubStatus(null);
    setPersonalGitHubRepositories([]);
    setPersonalGitHubSelection(null);
    setPersonalGitHubCatalogReady(false);
    setPersonalGitHubAuthorityCache(null);
    setWorkspaceMcpServers([]);
    setWorkspaceCapabilityCatalog([]);
    setWorkspaceMcpCatalogReady(false);
  }, []);

  const resetWorkspaceState = useCallback(
    (workspaceId: string | null, force: boolean) => {
      const previousWorkspaceId = workspaceTransitionIdentity.current.workspaceId;
      const transition =
        workspaceId === null
          ? {
              identity: invalidateWorkspaceTransition(workspaceTransitionIdentity.current),
              changed: true,
            }
          : beginWorkspaceTransition(workspaceTransitionIdentity.current, workspaceId);
      if (!force && !transition.changed) {
        return;
      }
      workspaceTransitionIdentity.current = transition.identity;
      if (previousWorkspaceId && (force || previousWorkspaceId !== workspaceId)) {
        sessionChannelProjectionAuthority.clearWorkspace(previousWorkspaceId);
      }
      activeCreateOperation.current = null;
      activeGitHubManifestOperation.current = null;
      activeGitHubDisconnectOperation.current = null;
      // Fence late non-abortable catalog/status responses before clearing the
      // projections they would otherwise be able to repopulate.
      githubRefreshId.current += 1;
      personalGitHubRefreshId.current += 1;
      mcpRefreshId.current += 1;
      pendingCreateAttempt.current = null;
      resetSessionView();
      setInspectorOpen(false);
      setManualRepos([]);
      setManualReposOpen(false);
      setNextRepoId(1);
      setSelectedRepoIds(new Set());
      setSelectedRepoRefs({});
      setSelectedPersonalGitHubRepoIds(new Set());
      setSelectedPersonalGitHubRepoRefs({});
      setSelectedCapabilityToolIds(new Set());
      previousCapabilityToolIds.current = new Set();
      appliedWorkspaceToolDefaultsKey.current = null;
      setGithubAppOpen(false);
      setGithubOrg("");
      setBusy(false);
      setRepoBusy(false);
      setGithubAppBusy(false);
      setPersonalGitHubBusy(false);
      resetWorkspaceIntegrations();
      setWorkspaceStateOwnerId(workspaceId);
    },
    [resetSessionView, resetWorkspaceIntegrations, sessionChannelProjectionAuthority],
  );

  const prepareWorkspaceTransition = useCallback(
    (workspaceId: string) => resetWorkspaceState(workspaceId, false),
    [resetWorkspaceState],
  );

  const captureWorkspaceInvocation = useCallback(
    (workspaceId: string): WorkspaceTransitionIdentity | null => {
      const accepted = workspaceTransitionIdentity.current;
      return ownsWorkspaceTransition(accepted, accepted, workspaceId) ? accepted : null;
    },
    [],
  );

  const ownsWorkspaceInvocation = useCallback(
    (workspaceId: string, accepted: WorkspaceTransitionIdentity): boolean =>
      ownsWorkspaceTransition(workspaceTransitionIdentity.current, accepted, workspaceId),
    [],
  );

  const invalidatePrincipalWorkspaceState = useCallback(
    (options?: { preservePendingSlackLink?: boolean }) => {
      principalTransitionIdentity.current = invalidatePrincipalTransition(
        principalTransitionIdentity.current,
      );
      authPrincipalIdRef.current = null;
      accessPrincipalIdRef.current = null;
      managedSelfContextIdentityRef.current = null;
      setManagedSelfContext(null);
      if (options?.preservePendingSlackLink !== true) {
        slackLinkPrepareController.clear();
        setSlackLinkContinuationWorkspaceId(null);
      }
      resetWorkspaceState(null, true);
    },
    [resetWorkspaceState],
  );

  useEffect(() => {
    if (isPublicDevHarness) return;
    let cancelled = false;
    void fetchClientConfig()
      .then((config) => {
        if (cancelled) {
          return;
        }
        setClientConfig(config);
        setConfigError(null);
        setModel(config.defaultModel);
        // Sync to the deployment default UNCONDITIONALLY: the full enum is now
        // representable, so a `none`/`minimal` default no longer gets clamped to
        // the "low" placeholder (which the server treated as an override beating
        // the deployer's configured default — a silent billing footgun).
        setReasoningEffort(initialReasoningEffort(config));
        setLatencyMode("standard");
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setConfigError(message);
        toast.error("Failed to load client config", { description: message });
      });
    return () => {
      cancelled = true;
    };
  }, [isPublicDevHarness]);

  useEffect(() => {
    if (!clientConfig) {
      setManagedAuthBootstrapComplete(false);
      return;
    }
    if (clientConfig.auth.mode !== "managedSession") {
      if (authPrincipalIdRef.current !== null) {
        invalidatePrincipalWorkspaceState();
      }
      setAuthSession(null);
      setManagedAuthBootstrapComplete(true);
      return;
    }
    let cancelled = false;
    const acceptedPrincipal = principalTransitionIdentity.current;
    setManagedAuthBootstrapComplete(false);
    setAuthSession(undefined);
    void fetchAuthSession()
      .then((nextSession) => {
        if (
          cancelled ||
          !ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal)
        ) {
          return;
        }
        const nextPrincipalId = nextSession?.user.id ?? null;
        if (authPrincipalIdRef.current !== null && authPrincipalIdRef.current !== nextPrincipalId) {
          invalidatePrincipalWorkspaceState();
        }
        authPrincipalIdRef.current = nextPrincipalId;
        setAuthSession(nextSession);
        setManagedAuthBootstrapComplete(true);
      })
      .catch(() => {
        if (
          cancelled ||
          !ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal)
        ) {
          return;
        }
        setAuthSession(null);
        setManagedAuthBootstrapComplete(true);
      });
    return () => {
      cancelled = true;
    };
  }, [clientConfig, invalidatePrincipalWorkspaceState]);

  useEffect(() => {
    if (!clientConfig || !authReady) {
      setAccessContext(null);
      setWorkspaces([]);
      managedSelfContextIdentityRef.current = null;
      setManagedSelfContext(null);
      setAccessLoading(false);
      setAccessError(null);
      return;
    }
    let cancelled = false;
    let acceptedPrincipal = principalTransitionIdentity.current;
    const acceptedManagedIdentity =
      clientConfig.auth.mode === "managedSession" && authSession
        ? managedSelfContextIdentity({
            credentialGeneration: accessKeyVersion,
            managedUserId: authSession.user.id,
          })
        : null;
    managedSelfContextIdentityRef.current = acceptedManagedIdentity;
    setManagedSelfContext(null);
    setAccessLoading(true);
    setAccessError(null);
    const selfContextPromise = acceptedManagedIdentity
      ? loadCurrentManagedSelfContext({
          identity: acceptedManagedIdentity,
          currentIdentity: () => managedSelfContextIdentityRef.current,
          request: () => client.listOrganizationMemberships(),
        })
      : Promise.resolve(null);
    void Promise.all([client.getAccessContext(), client.listWorkspaces(), selfContextPromise])
      .then(([context, nextWorkspaces, nextManagedSelfContext]) => {
        if (
          cancelled ||
          !ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal)
        ) {
          return;
        }
        if (acceptedManagedIdentity && nextManagedSelfContext === null) {
          return;
        }
        if (
          nextManagedSelfContext &&
          context.subjectId !== nextManagedSelfContext.identity.subjectId
        ) {
          throw new Error("managed self context did not match the authenticated subject");
        }
        if (
          accessPrincipalIdRef.current !== null &&
          accessPrincipalIdRef.current !== context.subjectId
        ) {
          invalidatePrincipalWorkspaceState();
          acceptedPrincipal = principalTransitionIdentity.current;
          // The newly returned access + membership tuple is already bound to
          // the accepted current cookie identity. Restore that identity after
          // clearing the prior principal's workspace state.
          managedSelfContextIdentityRef.current = acceptedManagedIdentity;
        }
        accessPrincipalIdRef.current = context.subjectId;
        setAccessContext(context);
        setWorkspaces(nextWorkspaces);
        setManagedSelfContext(nextManagedSelfContext);
      })
      .catch((error) => {
        if (
          cancelled ||
          !ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal)
        ) {
          return;
        }
        toast.error("Failed to load workspace access", {
          description: String(error),
        });
        setAccessContext(null);
        setWorkspaces([]);
        setAccessError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (
          !cancelled &&
          ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal)
        ) {
          setAccessLoading(false);
        }
      });
    return () => {
      cancelled = true;
      if (managedSelfContextIdentityRef.current === acceptedManagedIdentity) {
        managedSelfContextIdentityRef.current = null;
      }
    };
  }, [
    accessKeyVersion,
    authSession,
    clientConfig,
    authReady,
    client,
    invalidatePrincipalWorkspaceState,
  ]);

  // New-chat policy follows the active workspace. Explicit composer choices
  // remain local until the route moves to another workspace or its durable
  // default changes; unrelated workspace updates do not reset the picker.
  useEffect(() => {
    if (!clientConfig) return;
    const workspaceId = /^\/workspaces\/([^/]+)/.exec(pathname)?.[1] ?? null;
    if (!workspaceId) return;
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;
    const configured = resolveWorkspaceSessionDefaults(workspace.settings);
    const nextModel = configured?.model ?? clientConfig.defaultModel;
    const nextEffort = configured?.reasoningEffort ?? initialReasoningEffort(clientConfig);
    const key = `${workspaceId}\u0000${nextModel}\u0000${nextEffort}`;
    if (appliedWorkspaceSessionDefaultsKey.current === key) return;
    appliedWorkspaceSessionDefaultsKey.current = key;
    setModel(nextModel);
    setReasoningEffort(nextEffort);
    setLatencyMode("standard");
  }, [clientConfig, pathname, workspaces]);

  const selectedInstalledRepositories = githubRepos.filter((repo) => selectedRepoIds.has(repo.id));
  const selectedInstallationId = selectedInstalledRepositories[0]?.installationId ?? null;
  const repositoryGroups = useMemo(() => groupRepositories(githubRepos), [githubRepos]);
  const toolMcpServers = useMemo(
    () => mergeMcpServerOptions(selectableMcpServers(clientConfig), workspaceMcpServers),
    [clientConfig, workspaceMcpServers],
  );
  const routedWorkspaceId = /^\/workspaces\/([^/]+)/.exec(pathname)?.[1] ?? null;
  const routedWorkspace =
    workspaces.find((workspace) => workspace.id === routedWorkspaceId) ?? null;
  const configuredWorkspaceToolDefaults = useMemo(
    () => resolveWorkspaceSessionToolDefaults(routedWorkspace?.settings),
    [routedWorkspace?.settings],
  );
  const workspaceDefaultToolIds = useMemo(() => {
    const available = new Set(toolMcpServers.map((server) => server.id));
    const configured = configuredWorkspaceToolDefaults?.mcpServerIds;
    return configured
      ? configured.filter((id) => available.has(id))
      : toolMcpServers.map((server) => server.id);
  }, [configuredWorkspaceToolDefaults, toolMcpServers]);
  const currentResources = useMemo(
    () =>
      buildResources(
        manualRepos,
        githubRepos,
        selectedRepoIds,
        selectedRepoRefs,
        personalGitHubRepositories,
        selectedPersonalGitHubRepoIds,
        selectedPersonalGitHubRepoRefs,
        personalGitHubSelection?.credentialBindingId ?? null,
      ),
    [
      manualRepos,
      githubRepos,
      selectedRepoIds,
      selectedRepoRefs,
      personalGitHubRepositories,
      selectedPersonalGitHubRepoIds,
      selectedPersonalGitHubRepoRefs,
      personalGitHubSelection?.credentialBindingId,
    ],
  );

  useEffect(() => {
    if (!clientConfig) {
      return;
    }
    const availableIds = toolMcpServers.map((server) => server.id);
    const defaultsKey = `${routedWorkspaceId ?? ""}\u0000${[...workspaceDefaultToolIds]
      .sort()
      .join("\u0000")}`;
    if (appliedWorkspaceToolDefaultsKey.current !== defaultsKey) {
      appliedWorkspaceToolDefaultsKey.current = defaultsKey;
      setSelectedCapabilityToolIds(new Set(workspaceDefaultToolIds));
      previousCapabilityToolIds.current = new Set(availableIds);
      return;
    }
    setSelectedCapabilityToolIds((current) =>
      selectedAvailableCapabilityToolIds(
        current,
        availableIds,
        previousCapabilityToolIds.current,
        workspaceDefaultToolIds,
      ),
    );
    previousCapabilityToolIds.current = new Set(availableIds);
  }, [clientConfig, routedWorkspaceId, toolMcpServers, workspaceDefaultToolIds]);

  // Workspace create/rename keep the cached `workspaces` list and the access
  // context (the create grants the caller an owner grant) in sync.
  async function createWorkspace(request: CreateWorkspaceRequest): Promise<Workspace | null> {
    const acceptedTransition = workspaceTransitionIdentity.current;
    const ownsInvocation = () =>
      ownsTransitionInvocation(workspaceTransitionIdentity.current, acceptedTransition);
    let created: Workspace;
    try {
      const creation = await runCurrentTransitionInvocation({
        isCurrent: ownsInvocation,
        request: async () => await client.createWorkspace(request),
      });
      if (creation.status === "stale") return null;
      created = creation.value;
    } catch (error) {
      toast.error("Failed to create workspace", {
        description: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    setWorkspaces((current) => upsertWorkspace(current, created));
    captureProductAnalyticsEvent("workspace_created", {
      $insert_id: `workspace_created:${created.id}`,
      account_id: created.accountId,
      workspace_id: created.id,
    });
    // Refresh grants so the new workspace's owner permissions apply at once;
    // the workspace itself is already usable if this refresh fails — surface a
    // soft warning so a stale permission set doesn't fail silently.
    try {
      const accessRefresh = await runCurrentTransitionInvocation({
        isCurrent: ownsInvocation,
        request: async () => await client.getAccessContext(),
      });
      if (accessRefresh.status === "stale") return null;
      setAccessContext(accessRefresh.value);
    } catch {
      toast.warning("Permissions may be out of date", {
        description: "Reload if something looks off.",
      });
    }
    return created;
  }

  async function renameWorkspace(workspaceId: string, name: string): Promise<Workspace | null> {
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return null;
    try {
      const update = await runCurrentTransitionInvocation({
        isCurrent: () => ownsWorkspaceInvocation(workspaceId, acceptedTransition),
        request: async () => await client.updateWorkspace(workspaceId, { name }),
      });
      if (update.status === "stale") return null;
      setWorkspaces((current) => upsertWorkspace(current, update.value));
      return update.value;
    } catch (error) {
      toast.error("Failed to rename workspace", {
        description: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async function setWorkspaceInferenceControl(
    workspaceId: string,
    action: "pause" | "resume",
  ): Promise<boolean> {
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return false;
    const current = workspaces.find((workspace) => workspace.id === workspaceId);
    const update = await runCurrentTransitionInvocation({
      isCurrent: () => ownsWorkspaceInvocation(workspaceId, acceptedTransition),
      request: async () =>
        await client.setWorkspaceInferenceState(workspaceId, {
          action,
          clientEventId: crypto.randomUUID(),
          ...(current ? { expectedRevision: current.inferenceControl.revision } : {}),
        }),
    });
    if (update.status === "stale") return false;
    const response = update.value;
    setWorkspaces((all) =>
      all.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              inferenceControl: {
                state: response.state,
                revision: response.revision,
                reason: null,
                changedBy: null,
                changedAt: new Date().toISOString(),
              },
            }
          : workspace,
      ),
    );
    return true;
  }

  const refreshWorkspace = useCallback(
    async (workspaceId: string): Promise<void> => {
      const acceptedTransition = captureWorkspaceInvocation(workspaceId);
      if (!acceptedTransition) return;
      const refresh = await runCurrentTransitionInvocation({
        isCurrent: () => ownsWorkspaceInvocation(workspaceId, acceptedTransition),
        request: async () => await client.getWorkspace(workspaceId),
      });
      if (refresh.status === "stale") return;
      setWorkspaces((current) => upsertWorkspace(current, refresh.value));
    },
    [captureWorkspaceInvocation, client, ownsWorkspaceInvocation],
  );

  // Settings PATCH deep-merges server-side; upsert the returned workspace so the
  // cached list (and any settings-derived UI, e.g. the Documents memory pane)
  // reflects the change without a reload.
  async function updateWorkspaceSettings(
    workspaceId: string,
    settings: UpdateWorkspaceSettingsRequest,
  ): Promise<Workspace | null> {
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return null;
    try {
      const update = await runCurrentTransitionInvocation({
        isCurrent: () => ownsWorkspaceInvocation(workspaceId, acceptedTransition),
        request: async () => await client.updateWorkspaceSettings(workspaceId, settings),
      });
      if (update.status === "stale") return null;
      setWorkspaces((current) => upsertWorkspace(current, update.value));
      return update.value;
    } catch (error) {
      toast.error("Failed to update workspace settings", {
        description: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async function setWorkspaceDefaultRig(
    workspaceId: string,
    rigId: string | null,
  ): Promise<Workspace | null> {
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return null;
    try {
      const update = await runCurrentTransitionInvocation({
        isCurrent: () => ownsWorkspaceInvocation(workspaceId, acceptedTransition),
        request: async () =>
          await client.setWorkspaceDefaultRig(workspaceId, {
            rigId,
          }),
      });
      if (update.status === "stale") return null;
      setWorkspaces((current) => upsertWorkspace(current, update.value));
      return update.value;
    } catch (error) {
      toast.error("Failed to update the workspace default rig", {
        description: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // Manual session rename: writes a permanent (source='user') title via the
  // PATCH route, then patches the open session in-place so the header reflects
  // it at once. The rail list (its own polled hook) and any cross-client view
  // pick the change up via the session.title_set SSE event / next poll.
  async function updateSessionTitle(
    workspaceId: string,
    sessionId: string,
    title: string,
  ): Promise<Session | null> {
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return null;
    try {
      const update = await runCurrentTransitionInvocation({
        isCurrent: () => ownsWorkspaceInvocation(workspaceId, acceptedTransition),
        request: async () =>
          await client.updateSession(workspaceId, sessionId, {
            title,
          }),
      });
      if (update.status === "stale") return null;
      const updated = update.value;
      setSession((current) =>
        current && current.id === updated.id
          ? {
              ...current,
              title: updated.title,
              titleSource: updated.titleSource,
            }
          : current,
      );
      return updated;
    } catch (error) {
      toast.error("Failed to rename session", {
        description: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // Personal session pinning never changes shared session activity. Keep the
  // header immediate on this device, use its known revision when available, and
  // restore the authoritative prior state if the request (including a stale-tab
  // 409) fails. The rail owns its own corresponding optimistic list projection.
  async function updateSessionPin(
    workspaceId: string,
    sessionId: string,
    pinned: boolean,
    expectedVersion?: number,
  ): Promise<Session | null> {
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return null;
    const ownsInvocation = () => ownsWorkspaceInvocation(workspaceId, acceptedTransition);
    const before = session;
    const optimisticVersion = (expectedVersion ?? before?.pinVersion ?? 0) + 1;
    const optimistic: Session | null =
      before && before.id === sessionId
        ? {
            ...before,
            pinned,
            pinnedAt: pinned ? new Date().toISOString() : null,
            pinVersion: optimisticVersion,
          }
        : null;
    if (optimistic) {
      setSession(optimistic);
    }
    try {
      const update = await runCurrentTransitionInvocation({
        isCurrent: ownsInvocation,
        request: async () =>
          await client.updateSessionPin(workspaceId, sessionId, {
            pinned,
            ...(expectedVersion !== undefined ? { expectedVersion } : {}),
          }),
      });
      if (update.status === "stale") return null;
      const updated = update.value;
      // The mutation can race a newer page poll/other-device write, and its
      // full Session projection can lag lifecycle/SSE fields. Merge only the
      // monotonic personal pin fields rather than replacing the open session.
      setSession((current) => applySessionPinProjection(current, updated));
      notifySessionPinChanged(workspaceId, sessionId);
      return updated;
    } catch (error) {
      // Re-read on every failure, not only OCC conflicts. A transport failure
      // may have happened after the server committed; blindly restoring
      // `before` would temporarily lie and could overwrite a newer device.
      const reconciliation = await runCurrentTransitionInvocation({
        isCurrent: ownsInvocation,
        request: async () =>
          await client.getSession(workspaceId, sessionId, { fresh: true }).catch(() => null),
      });
      if (reconciliation.status === "stale") return null;
      const authoritative = reconciliation.value;
      if (authoritative) {
        setSession((current) => reconcileFailedSessionPin(current, optimistic, authoritative));
        notifySessionPinChanged(workspaceId, sessionId);
        // A lost response after commit is a successful desired-state mutation,
        // not a failed pin. Returning the point-read result keeps the UI
        // announcement honest while preserving the same idempotent retry path.
        if (Boolean(authoritative.pinned) === pinned) {
          return authoritative;
        }
      } else if (optimistic) {
        // If reconciliation is also unavailable (for example while offline),
        // roll back only the exact optimistic projection this call installed.
        // Any intervening poll/device response remains untouched.
        setSession((current) =>
          current?.id === sessionId &&
          Boolean(current.pinned) === Boolean(optimistic.pinned) &&
          (current.pinnedAt ?? null) === (optimistic.pinnedAt ?? null) &&
          (current.pinVersion ?? 0) === (optimistic.pinVersion ?? 0)
            ? before
            : current,
        );
      }
      toast.error(
        error instanceof OpenGeniApiError && error.status === 409
          ? "Session pin changed elsewhere"
          : `Couldn't ${pinned ? "pin" : "unpin"} session`,
        {
          description: error instanceof Error ? error.message : String(error),
        },
      );
      return null;
    }
  }

  // Delete drops the workspace from the cached list and refreshes grants (the
  // owner grant for the deleted workspace is gone). The caller navigates away.
  async function deleteWorkspace(workspaceId: string): Promise<boolean> {
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return false;
    const ownsInvocation = () => ownsWorkspaceInvocation(workspaceId, acceptedTransition);
    try {
      const deletion = await runCurrentTransitionInvocation({
        isCurrent: ownsInvocation,
        request: async () => await client.deleteWorkspace(workspaceId),
      });
      if (deletion.status === "stale") return false;
    } catch (error) {
      toast.error("Failed to delete workspace", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    setWorkspaces((current) => current.filter((workspace) => workspace.id !== workspaceId));
    try {
      const accessRefresh = await runCurrentTransitionInvocation({
        isCurrent: ownsInvocation,
        request: async () => await client.getAccessContext(),
      });
      if (accessRefresh.status === "stale") return false;
      setAccessContext(accessRefresh.value);
    } catch {
      toast.warning("Permissions may be out of date", {
        description: "Reload if something looks off.",
      });
    }
    return true;
  }

  const refreshGitHub = useCallback(
    async (workspaceId: string, signal?: AbortSignal, options?: { sync?: boolean }) => {
      const acceptedTransition = workspaceTransitionIdentity.current;
      if (!ownsWorkspaceTransition(acceptedTransition, acceptedTransition, workspaceId)) {
        return;
      }
      const ownsRefresh = () =>
        ownsWorkspaceTransition(
          workspaceTransitionIdentity.current,
          acceptedTransition,
          workspaceId,
        );
      const refreshId = githubRefreshId.current + 1;
      githubRefreshId.current = refreshId;
      setRepoBusy(true);
      try {
        const status = await client.getGitHubApp(workspaceId);
        if (signal?.aborted || githubRefreshId.current !== refreshId || !ownsRefresh()) {
          return;
        }
        setGithubStatus(status);
        setGithubStatusFailed(false);
        setGithubAppOpen(status.status !== "bound");
        if (status.status === "bound") {
          // Explicit refreshes re-sync from GitHub (POST /github/repositories/sync)
          // so installations changed after connect show up; passive loads read
          // OpenGeni's cached rows.
          const { repositories } = options?.sync
            ? await client.syncGitHubRepositories(workspaceId)
            : await client.listGitHubRepositories(workspaceId);
          if (signal?.aborted || githubRefreshId.current !== refreshId || !ownsRefresh()) {
            return;
          }
          setGithubRepos(repositories);
          setGithubCatalogReady(true);
        } else {
          setGithubRepos([]);
          setGithubCatalogReady(true);
        }
      } catch (error) {
        if (
          isAbortError(error) ||
          signal?.aborted ||
          githubRefreshId.current !== refreshId ||
          !ownsRefresh()
        ) {
          return;
        }
        // A failed status/catalog request is unavailable/unknown, not proof
        // that the last-known installation or repository identities vanished.
        // Keep the last successful snapshot and leave readiness unchanged: a
        // first-load failure must not look like an empty catalog, or draft
        // hydration would drop GitHub-identity repos and autosave that loss.
        setGithubStatusFailed(true);
        toast.error("GitHub status unavailable", {
          description: String(error),
        });
      } finally {
        if (githubRefreshId.current === refreshId && ownsRefresh()) {
          setRepoBusy(false);
        }
      }
    },
    [client],
  );

  const refreshPersonalGitHub = useCallback(
    async (workspaceId: string, signal?: AbortSignal): Promise<void> => {
      const acceptedTransition = workspaceTransitionIdentity.current;
      if (!ownsWorkspaceTransition(acceptedTransition, acceptedTransition, workspaceId)) return;
      const refreshId = personalGitHubRefreshId.current + 1;
      personalGitHubRefreshId.current = refreshId;
      const ownsRefresh = () =>
        ownsWorkspaceTransition(
          workspaceTransitionIdentity.current,
          acceptedTransition,
          workspaceId,
        ) && personalGitHubRefreshId.current === refreshId;
      setPersonalGitHubBusy(true);
      try {
        const status = await client.personalGitHubStatus(workspaceId);
        if (signal?.aborted || !ownsRefresh()) return;
        const connection = status.connection;
        setPersonalGitHubStatus(status);
        setPersonalGitHubAuthorityCache((current) =>
          connection &&
          reusablePersonalGitHubAuthority(current, {
            connectionId: connection.id,
            connectionVersion: connection.version,
          })
            ? current
            : null,
        );
        if (!status.enabled || connection?.status !== "active") {
          setPersonalGitHubRepositories([]);
          setPersonalGitHubSelection(null);
          setSelectedPersonalGitHubRepoIds(new Set());
          setSelectedPersonalGitHubRepoRefs({});
          setPersonalGitHubCatalogReady(true);
          return;
        }
        const repositories: PersonalGitHubRepositoryCatalogItem[] = [];
        let cursor: number | undefined;
        let selection: PersonalGitHubRepositorySelectionState | null = null;
        do {
          const page = await client.listPersonalGitHubRepositories(workspaceId, connection.id, {
            ...(cursor ? { cursor } : {}),
            limit: 100,
          });
          repositories.push(...page.repositories);
          selection = page.selection;
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined && repositories.length < 1_000);
        if (signal?.aborted || !ownsRefresh()) return;
        setPersonalGitHubRepositories(repositories);
        setPersonalGitHubSelection(selection);
        setPersonalGitHubAuthorityCache((current) =>
          selection &&
          reusablePersonalGitHubAuthority(current, {
            connectionId: connection.id,
            connectionVersion: connection.version,
            connectionAuthorityGeneration: selection.connectionAuthorityGeneration,
          })
            ? current
            : null,
        );
        setSelectedPersonalGitHubRepoIds(
          (current) =>
            new Set(
              [...current].filter((id) =>
                repositories.some((repo) => repo.repositoryId === id && repo.selectedAccess),
              ),
            ),
        );
        setPersonalGitHubCatalogReady(true);
      } catch (error) {
        if (signal?.aborted || !ownsRefresh() || isAbortError(error)) return;
        setPersonalGitHubCatalogReady(true);
        toast.error("Your GitHub account is unavailable", {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (ownsRefresh()) setPersonalGitHubBusy(false);
      }
    },
    [client],
  );

  async function beginPersonalGitHubOAuth(workspaceId: string, reconnect: boolean): Promise<void> {
    const connection = personalGitHubStatus?.connection;
    try {
      const result =
        reconnect && connection
          ? await client.reconnectPersonalGitHub(workspaceId, connection.id, {
              returnPath: `/workspaces/${workspaceId}/capabilities`,
            })
          : await client.startPersonalGitHubOAuth(workspaceId, {
              returnPath: `/workspaces/${workspaceId}/capabilities`,
            });
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      toast.error("Couldn't open GitHub sign-in", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function disconnectPersonalGitHub(workspaceId: string): Promise<boolean> {
    const connection = personalGitHubStatus?.connection;
    if (!connection) return true;
    setPersonalGitHubBusy(true);
    try {
      await client.disconnectPersonalGitHub(workspaceId, connection.id, {
        expectedVersion: connection.version,
        idempotencyKey: crypto.randomUUID(),
      });
      await refreshPersonalGitHub(workspaceId);
      toast.success("Your GitHub account was disconnected");
      return true;
    } catch (error) {
      toast.error("Couldn't disconnect your GitHub account", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setPersonalGitHubBusy(false);
    }
  }

  async function savePersonalGitHubRepositories(
    workspaceId: string,
    repositories: PersonalGitHubRepositorySelectionInput[],
  ): Promise<boolean> {
    const connection = personalGitHubStatus?.connection;
    const selection = personalGitHubSelection;
    if (!connection || !selection) return false;
    setPersonalGitHubBusy(true);
    try {
      await client.replacePersonalGitHubRepositorySelections(workspaceId, connection.id, {
        expectedConnectionAuthorityGeneration: selection.connectionAuthorityGeneration,
        expectedSelectionGeneration: selection.selectionGeneration,
        idempotencyKey: crypto.randomUUID(),
        repositories,
      });
      await refreshPersonalGitHub(workspaceId);
      toast.success("GitHub repository access updated");
      return true;
    } catch (error) {
      toast.error("Couldn't update GitHub repository access", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setPersonalGitHubBusy(false);
    }
  }

  async function ensurePersonalGitHubAuthority(
    workspaceId: string,
    context: "user_private" | "workspace_shared" = "workspace_shared",
  ): Promise<McpConnectionAuthoritySelection | null> {
    const connection = personalGitHubStatus?.connection;
    if (!connection?.authorityId || connection.status !== "active") {
      toast.error("Connect your GitHub account before selecting its repositories");
      return null;
    }
    const cached = reusablePersonalGitHubAuthority(personalGitHubAuthorityCache, {
      connectionId: connection.id,
      connectionVersion: connection.version,
      ...(personalGitHubSelection
        ? { connectionAuthorityGeneration: personalGitHubSelection.connectionAuthorityGeneration }
        : {}),
      context,
    });
    if (cached) return cached;
    try {
      const response = await client.issueUserResourceGrant(workspaceId, connection.authorityId, {
        scope: "user",
        resourceKind: "connection",
        mode: "always",
        context,
        workspaceSharedAcknowledged: context === "workspace_shared",
      });
      const authority = {
        serverId: "github:personal",
        connectionId: connection.id,
        userDelegation: response.grant.delegation,
      } satisfies McpConnectionAuthoritySelection;
      setPersonalGitHubAuthorityCache({ authority, connectionVersion: connection.version });
      return authority;
    } catch (error) {
      toast.error("Couldn't allow your GitHub identity here", {
        description: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async function togglePersonalGitHubRepository(
    workspaceId: string,
    repository: PersonalGitHubRepositoryCatalogItem,
  ): Promise<void> {
    if (selectedPersonalGitHubRepoIds.has(repository.repositoryId)) {
      setSelectedPersonalGitHubRepoIds((current) => {
        const next = new Set(current);
        next.delete(repository.repositoryId);
        return next;
      });
      return;
    }
    if (!repository.selectedAccess) return;
    if (!(await ensurePersonalGitHubAuthority(workspaceId))) return;
    setSelectedRepoIds(
      (current) =>
        new Set(
          [...current].filter(
            (id) =>
              githubRepos.find((candidate) => candidate.id === id)?.fullName.toLowerCase() !==
              repository.fullName.toLowerCase(),
          ),
        ),
    );
    setSelectedPersonalGitHubRepoIds((current) => new Set(current).add(repository.repositoryId));
    setSelectedPersonalGitHubRepoRefs((current) => ({
      ...current,
      [repository.repositoryId]: current[repository.repositoryId] ?? repository.defaultBranch,
    }));
  }

  const refreshWorkspaceMcpServers = useCallback(
    async (workspaceId: string, signal?: AbortSignal) => {
      const refreshId = mcpRefreshId.current + 1;
      mcpRefreshId.current = refreshId;
      const requestKey = `${accessKeyVersion}:${workspaceId}`;
      try {
        const result = await runCurrentWorkspaceRequest({
          signal,
          requestId: refreshId,
          currentRequestId: () => mcpRefreshId.current,
          request: async () =>
            await Promise.all([
              runSingleFlight(
                mcpCatalogRequests.current,
                requestKey,
                async () => await client.listCapabilities(workspaceId),
              ),
              client.listApiIntegrations(workspaceId),
            ]),
        });
        if (!result) {
          return;
        }
        const [catalog, apiIntegrations] = result;
        setWorkspaceMcpServers(
          mergeMcpServerOptions(
            enabledWorkspaceCapabilityMcpServers(catalog.items),
            installedApiIntegrationMcpServers(apiIntegrations.integrations),
          ),
        );
        setWorkspaceCapabilityCatalog(catalog.items);
        setWorkspaceMcpCatalogReady(true);
      } catch (error) {
        if (signal?.aborted || mcpRefreshId.current !== refreshId) throw error;
        // Fail-open: an unavailable catalog must not leave the create composer
        // stuck on draft hydrate / canSend=false.
        setWorkspaceMcpCatalogReady(true);
        throw error;
      }
    },
    [accessKeyVersion, client],
  );

  async function startSession(
    workspaceId: string,
    submission: TurnSubmission,
    options?: {
      instructions?: string;
      /** Exact session MCP policy. Omit to use the product UI's workspace selection. */
      sessionTools?: ToolRef[];
      targetSandboxId?: string | null;
      workingDir?: string | null;
      channelId?: string | null;
      omitWorkspaceResources?: boolean;
      expectedNewSessionDraftRevision?: number;
      startMode?: "realtime";
      visibility?: "private" | "workspace";
      onFailure?: (failure: StartSessionFailure) => void;
    },
  ): Promise<Session | null> {
    const startedOperation = beginWorkspaceOperation(
      workspaceOperationSequence.current,
      workspaceTransitionIdentity.current,
    );
    workspaceOperationSequence.current = startedOperation.sequence;
    const operation = startedOperation.operation;
    activeCreateOperation.current = operation;
    let attempted: ReturnType<typeof prepareCreateSessionAttempt> | null = null;
    setBusy(true);
    try {
      const sessionTools = options?.sessionTools;
      if (!workspaceMcpCatalogReady && !sessionTools) {
        toast.error("Tools are still loading", {
          description: "Wait for the workspace tool catalog to finish loading, then try again.",
        });
        return null;
      }
      const selectedTools = sessionTools
        ? [...sessionTools]
        : buildOpenGeniUiTools(submission.tools, selectedCapabilityToolIds);
      const includesPersonalGitHub = currentResources.some(
        (resource) =>
          resource.kind === "repository" && resource.connectionType === "github_personal",
      );
      if (includesPersonalGitHub && !personalGitHubAuthority) {
        toast.error("Your GitHub identity is still being prepared", {
          description: "Select the repository again, then send when it is ready.",
        });
        return null;
      }
      const effectiveSubmission: TurnSubmission = includesPersonalGitHub
        ? {
            ...submission,
            connectionAuthorities: [
              ...(submission.connectionAuthorities ?? []).filter(
                (authority) => authority.serverId !== "github:personal",
              ),
              personalGitHubAuthority!,
            ],
          }
        : submission;
      const freshIdempotencyKey = crypto.randomUUID();
      const attempt = prepareCreateSessionAttempt({
        pending: pendingCreateAttempt.current,
        client,
        workspaceId,
        freshIdempotencyKey,
        request: buildCreateSessionRequest({
          currentResources,
          submission: effectiveSubmission,
          instructions: options?.instructions,
          omitWorkspaceResources: options?.omitWorkspaceResources,
          selectedTools,
          defaultModel: model,
          defaultReasoningEffort: reasoningEffort,
          defaultLatencyMode: latencyMode,
          clientEventId: crypto.randomUUID(),
          idempotencyKey: freshIdempotencyKey,
          workspaceDefaultMcpServerIds:
            configuredWorkspaceToolDefaults?.mcpServerIds ?? workspaceDefaultToolIds,
          workspaceMcpCatalogReady,
          targetSandboxId: options?.targetSandboxId,
          workingDir: options?.workingDir,
          channelId: options?.channelId,
          expectedNewSessionDraftRevision: options?.expectedNewSessionDraftRevision,
          startMode: options?.startMode,
          visibility: options?.visibility,
        }),
      });
      attempted = attempt;
      pendingCreateAttempt.current = attempt.pending;
      const created = await client.createSession(workspaceId, attempt.request);
      // Do not clear a newer concurrent attempt that replaced this one.
      if (pendingCreateAttempt.current?.idempotencyKey === attempt.pending.idempotencyKey) {
        pendingCreateAttempt.current = null;
      }
      // The create may commit after the operator has switched workspaces. The
      // server result remains valid, but it must not repopulate or navigate the
      // new workspace's UI with the previous tenant's session.
      if (
        !ownsWorkspaceOperation(
          activeCreateOperation.current,
          workspaceTransitionIdentity.current,
          operation,
          workspaceId,
        )
      ) {
        return null;
      }
      setSession(created);
      if (attempt.request.clientEventId && attempt.request.startMode !== "realtime") {
        setSessionCreationHandoff({
          session: created,
          clientEventId: attempt.request.clientEventId,
        });
      } else {
        setSessionCreationHandoff(null);
      }
      setConnectionState("idle");
      captureProductAnalyticsEvent("session_started", {
        $insert_id: `session_started:${created.id}`,
        account_id: created.accountId,
        workspace_id: created.workspaceId,
        session_id: created.id,
        ...(attempt.request.model ? { model: attempt.request.model } : {}),
        start_mode: options?.startMode ?? "standard",
      });
      return created;
    } catch (error) {
      const { error: problem, outcomeUnknown } = classifyCreateSessionFailure(error);
      if (attempted) {
        pendingCreateAttempt.current = retainCreateSessionAttemptAfterFailure({
          current: pendingCreateAttempt.current,
          attempted: attempted.pending,
          outcomeUnknown,
        });
      }
      if (
        ownsWorkspaceOperation(
          activeCreateOperation.current,
          workspaceTransitionIdentity.current,
          operation,
          workspaceId,
        )
      ) {
        if (attempted) {
          options?.onFailure?.({
            error: problem,
            request: attempted.request,
            outcomeUnknown,
          });
        }
        toast.error("Failed to start session", {
          description: composerSubmissionErrorMessage(problem),
        });
      }
      return null;
    } finally {
      const settlement = settleWorkspaceOperation(activeCreateOperation.current, operation);
      activeCreateOperation.current = settlement.active;
      if (settlement.settledCurrent) {
        setBusy(false);
      }
    }
  }

  async function startGitHubAppManifestFlow(workspaceId: string) {
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return;
    const started = beginWorkspaceOperation(
      githubManifestOperationSequence.current,
      acceptedTransition,
    );
    githubManifestOperationSequence.current = started.sequence;
    const operation = started.operation;
    activeGitHubManifestOperation.current = operation;
    setGithubAppBusy(true);
    try {
      const result = await runCurrentWorkspaceOperation({
        activeOperation: () => activeGitHubManifestOperation.current,
        currentTransition: () => workspaceTransitionIdentity.current,
        operation,
        workspaceId,
        request: async () =>
          await client.createGitHubAppManifest(workspaceId, {
            ...(githubOrg.trim() ? { organization: githubOrg.trim() } : {}),
            public: false,
            includeCiPermissions: true,
          }),
      });
      if (
        result.status === "stale" ||
        !ownsWorkspaceOperation(
          activeGitHubManifestOperation.current,
          workspaceTransitionIdentity.current,
          operation,
          workspaceId,
        )
      ) {
        return;
      }
      submitGitHubManifest(result.value.actionUrl, result.value.manifest);
    } catch (error) {
      if (
        ownsWorkspaceOperation(
          activeGitHubManifestOperation.current,
          workspaceTransitionIdentity.current,
          operation,
          workspaceId,
        )
      ) {
        toast.error("GitHub App setup failed", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      const settlement = settleWorkspaceOperation(activeGitHubManifestOperation.current, operation);
      activeGitHubManifestOperation.current = settlement.active;
      if (settlement.settledCurrent) {
        setGithubAppBusy(false);
      }
    }
  }

  async function disconnectGitHubInstallation(
    workspaceId: string,
    installationId: number,
  ): Promise<boolean> {
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return false;
    const started = beginWorkspaceOperation(
      githubDisconnectOperationSequence.current,
      acceptedTransition,
    );
    githubDisconnectOperationSequence.current = started.sequence;
    const operation = started.operation;
    activeGitHubDisconnectOperation.current = operation;
    try {
      const unlink = await runCurrentWorkspaceOperation({
        activeOperation: () => activeGitHubDisconnectOperation.current,
        currentTransition: () => workspaceTransitionIdentity.current,
        operation,
        workspaceId,
        request: async () => await client.unlinkGitHubInstallation(workspaceId, installationId),
      });
      if (
        unlink.status === "stale" ||
        !ownsWorkspaceOperation(
          activeGitHubDisconnectOperation.current,
          workspaceTransitionIdentity.current,
          operation,
          workspaceId,
        )
      ) {
        return false;
      }
      const removedRepositoryIds = new Set(
        githubRepos
          .filter((repository) => repository.installationId === installationId)
          .map((repository) => repository.id),
      );
      setSelectedRepoIds(
        (current) =>
          new Set([...current].filter((repositoryId) => !removedRepositoryIds.has(repositoryId))),
      );
      setSelectedRepoRefs((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([repositoryId]) => !removedRepositoryIds.has(Number(repositoryId)),
          ),
        ),
      );
      await refreshGitHub(workspaceId, undefined, { sync: true });
      if (
        !ownsWorkspaceOperation(
          activeGitHubDisconnectOperation.current,
          workspaceTransitionIdentity.current,
          operation,
          workspaceId,
        )
      ) {
        return false;
      }
      toast.success("GitHub installation unlinked from this workspace");
      return true;
    } catch (error) {
      if (
        ownsWorkspaceOperation(
          activeGitHubDisconnectOperation.current,
          workspaceTransitionIdentity.current,
          operation,
          workspaceId,
        )
      ) {
        toast.error("Failed to unlink GitHub installation", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
      return false;
    } finally {
      const settlement = settleWorkspaceOperation(
        activeGitHubDisconnectOperation.current,
        operation,
      );
      activeGitHubDisconnectOperation.current = settlement.active;
    }
  }

  function toggleGitHubRepository(repo: GitHubRepository) {
    if (
      selectedInstallationId !== null &&
      selectedInstallationId !== repo.installationId &&
      !selectedRepoIds.has(repo.id)
    ) {
      toast.info("This session uses one GitHub token", {
        description: "Clear selected repositories to choose repositories from another account.",
      });
      return;
    }
    setSelectedRepoIds((current) => {
      const next = new Set(current);
      if (next.has(repo.id)) {
        next.delete(repo.id);
      } else {
        next.add(repo.id);
      }
      return next;
    });
    if (!selectedRepoIds.has(repo.id)) {
      const personal = personalGitHubRepositories.find(
        (candidate) => candidate.fullName.toLowerCase() === repo.fullName.toLowerCase(),
      );
      if (personal) {
        setSelectedPersonalGitHubRepoIds((current) => {
          const next = new Set(current);
          next.delete(personal.repositoryId);
          return next;
        });
      }
    }
    setSelectedRepoRefs((current) => ({
      ...current,
      [repo.id]: current[repo.id] ?? repo.defaultBranch,
    }));
  }

  function addManualRepository() {
    setManualRepos((current) => [...current, { id: nextRepoId, url: "", ref: "main" }]);
    setNextRepoId((value) => value + 1);
    setManualReposOpen(true);
  }

  function saveAccessKey() {
    const key = accessKeyDraft.trim();
    if (!key) {
      toast.error("Enter an access key");
      return;
    }
    invalidatePrincipalWorkspaceState();
    setStoredAccessKey(key);
    setHasAccessKey(true);
    setAccessKeyDraft("");
    setAccessError(null);
    setAccessKeyVersion((version) => version + 1);
  }

  function forgetAccessKey() {
    invalidatePrincipalWorkspaceState();
    clearStoredAccessKey();
    setHasAccessKey(false);
    setSession(null);
    setAccessContext(null);
    setWorkspaces([]);
    setAccessError(null);
    setAccessKeyVersion((version) => version + 1);
  }

  async function handleManagedAuth(
    mode: "signin" | "signup",
    input: { name: string; email: string; password: string },
  ) {
    invalidatePrincipalWorkspaceState({
      preservePendingSlackLink: preserveSlackLinkForManagedAuth(
        mode,
        slackLinkPrepareController.phase(),
      ),
    });
    const acceptedPrincipal = principalTransitionIdentity.current;
    const ownsInvocation = () =>
      ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal);
    if (mode === "signup") {
      const signup = await runCurrentTransitionInvocation({
        isCurrent: ownsInvocation,
        request: async () => await signUpEmail(input),
      });
      if (signup.status === "stale") return;
      captureProductAnalyticsEvent("signup_submitted", {
        method: "email",
        verification_required: managedEmailVerificationRequired,
      });
    } else {
      const signin = await runCurrentTransitionInvocation({
        isCurrent: ownsInvocation,
        request: async () =>
          await signInEmail({
            email: input.email,
            password: input.password,
            rememberMe: true,
          }),
      });
      if (signin.status === "stale") return;
    }
    const sessionRead = await runCurrentTransitionInvocation({
      isCurrent: ownsInvocation,
      request: fetchAuthSession,
    });
    if (sessionRead.status === "stale") return;
    const nextSession = sessionRead.value;
    if (!nextSession && !(mode === "signup" && managedEmailVerificationRequired)) {
      throw new ManagedAuthSessionUnavailableError(mode);
    }
    authPrincipalIdRef.current = nextSession?.user.id ?? null;
    setAuthSession(nextSession);
    setAccessKeyVersion((version) => version + 1);
  }

  async function handleManagedSessionSetSignup(input: {
    name: string;
    email: string;
    password: string;
  }) {
    invalidatePrincipalWorkspaceState();
    const acceptedPrincipal = principalTransitionIdentity.current;
    const signup = await runCurrentTransitionInvocation({
      isCurrent: () =>
        ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal),
      request: async () => await signUpEmail(input),
    });
    if (signup.status === "stale") return;
    captureProductAnalyticsEvent("signup_submitted", {
      method: "email",
      verification_required: managedEmailVerificationRequired,
    });
  }

  async function handleManagedSocialAuth(provider: "google" | "github") {
    invalidatePrincipalWorkspaceState({
      preservePendingSlackLink: preserveSlackLinkForManagedAuth(
        "signin",
        slackLinkPrepareController.phase(),
      ),
    });
    await startManagedSocialSignIn(provider);
  }

  async function handleManagedSignOut() {
    invalidatePrincipalWorkspaceState();
    const acceptedPrincipal = principalTransitionIdentity.current;
    const ownsInvocation = () =>
      ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal);
    // Keep the authenticated tree hidden until an ambiguous response has been
    // reconciled against the authoritative cookie session.
    setAuthSession(undefined);
    setAccessContext(null);
    setWorkspaces([]);
    setAccessError(null);
    const reconciliation = await runCurrentTransitionInvocation({
      isCurrent: ownsInvocation,
      request: async () =>
        await signOutWithAuthoritativeReconciliation<AuthSession>({
          signOut: signOutManaged,
          readSession: fetchAuthSession,
        }),
    });
    if (reconciliation.status === "stale") return;
    const result = reconciliation.value;
    authPrincipalIdRef.current = result.session?.user.id ?? null;
    setAuthSession(result.session);
    // A definitive failure may restore the same user id. Rotate the client
    // identity anyway so access is loaded from the reconciled cookie result.
    setAccessKeyVersion((version) => version + 1);
    if (result.status === "reconciled_failure") {
      throw result.error;
    }
    setSession(null);
    await navigate({ to: "/", replace: true });
  }

  async function handleBrowserActorTransition(transition: BrowserAccountTransition) {
    // Commit the neutral auth/access surface before rotating transport
    // provenance. Aborting old requests while their routed tree is still
    // mounted lets rejection handlers/effects dispatch fresh work under the
    // next epoch. The synchronous commit removes those consumers first; the
    // immediately following rotation then aborts every remaining old request.
    flushSync(() => {
      invalidatePrincipalWorkspaceState();
      setAuthSession(undefined);
      setAccessContext(null);
      setWorkspaces([]);
      setAccessError(null);
    });
    configureManagedActorEpoch(transition.to?.actorEpoch ?? null);
    // Create the next client only after the old actor's transport and client
    // generation have been invalidated. This also reconnects streams for two
    // login bindings that resolve to the same canonical human but carry
    // distinct actor epochs.
    flushSync(() => {
      setAccessKeyVersion((version) => version + 1);
    });
    // A cross-tab/server hint first requests only the neutral fence. Do not
    // install or load any principal until the controller has reread authority
    // and invokes us again with the accepted projection.
    if (transition.to === null) return;
    if (transition.to.selectedSlotId === null || transition.to.state !== "ready") {
      // The authority reread has now proved that no tenant actor is selected.
      // Remove the revoked workspace/session deep link from browser history;
      // the earlier null transition is only a precommit hold and must not
      // navigate because its initiating mutation can still fail.
      authPrincipalIdRef.current = null;
      setAuthSession(null);
      setSession(null);
      await navigate({ to: "/", replace: true });
      return;
    }
    const acceptedPrincipal = principalTransitionIdentity.current;
    const ownsInvocation = () =>
      !transition.signal.aborted &&
      ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal);
    try {
      const sessionRead = await runCurrentTransitionInvocation({
        isCurrent: ownsInvocation,
        request: fetchAuthSession,
      });
      if (sessionRead.status === "stale") return;
      const nextSession = sessionRead.value;
      authPrincipalIdRef.current = nextSession?.user.id ?? null;
      setAuthSession(nextSession);
    } catch (error) {
      if (ownsInvocation()) setAuthSession(null);
      throw error;
    }
  }

  // Context actions keep one identity while reading the newest committed state
  // through the callback ref. This prevents unrelated provider renders
  // (for example, an access-key draft keystroke) from invalidating the entire
  // routed application tree.
  const contextAddManualRepository = useLatestCallback(addManualRepository);
  const contextForgetAccessKey = useLatestCallback(forgetAccessKey);
  const contextHandleManagedSignOut = useLatestCallback(handleManagedSignOut);
  const contextHandleBrowserActorTransition = useLatestCallback(handleBrowserActorTransition);
  const revalidatePrincipalAccess = useCallback(
    () => setAccessKeyVersion((version) => version + 1),
    [],
  );
  const contextCreateWorkspace = useLatestCallback(createWorkspace);
  const contextRenameWorkspace = useLatestCallback(renameWorkspace);
  const contextSetWorkspaceInferenceControl = useLatestCallback(setWorkspaceInferenceControl);
  const contextUpdateWorkspaceSettings = useLatestCallback(updateWorkspaceSettings);
  const contextSetWorkspaceDefaultRig = useLatestCallback(setWorkspaceDefaultRig);
  const contextUpdateSessionTitle = useLatestCallback(updateSessionTitle);
  const contextUpdateSessionPin = useLatestCallback(updateSessionPin);
  const contextDeleteWorkspace = useLatestCallback(deleteWorkspace);
  const contextStartGitHubAppManifestFlow = useLatestCallback(startGitHubAppManifestFlow);
  const contextDisconnectGitHubInstallation = useLatestCallback(disconnectGitHubInstallation);
  const contextToggleGitHubRepository = useLatestCallback(toggleGitHubRepository);
  const contextConnectPersonalGitHub = useLatestCallback((workspaceId: string) =>
    beginPersonalGitHubOAuth(workspaceId, false),
  );
  const contextReconnectPersonalGitHub = useLatestCallback((workspaceId: string) =>
    beginPersonalGitHubOAuth(workspaceId, true),
  );
  const contextDisconnectPersonalGitHub = useLatestCallback(disconnectPersonalGitHub);
  const contextSavePersonalGitHubRepositories = useLatestCallback(savePersonalGitHubRepositories);
  const contextEnsurePersonalGitHubAuthority = useLatestCallback(ensurePersonalGitHubAuthority);
  const contextTogglePersonalGitHubRepository = useLatestCallback(togglePersonalGitHubRepository);
  const contextStartSession = useLatestCallback(startSession);
  const preparePendingSlackLink = useCallback(
    async (workspaceId: string) =>
      await slackLinkPrepareController.prepare(
        workspaceId,
        async (token) =>
          await client.prepareSlackUserLinkAccess(workspaceId, {
            linkToken: token,
          }),
      ),
    [client],
  );
  const clearSlackLinkContinuation = useCallback(() => {
    slackLinkPrepareController.clear();
    setSlackLinkContinuationWorkspaceId(null);
  }, []);

  const appContext = useMemo<AppContextValue | null>(() => {
    return clientConfig && accessContext
      ? ({
          client,
          clientConfig,
          authSession: authSession ?? null,
          accessContext,
          workspaces,
          managedSelfContext,
          slackLinkContinuationWorkspaceId,
          invalidSlackLinkQueryWorkspaceId,
          preparePendingSlackLink,
          clearSlackLinkContinuation,
          accessKeyVersion,
          keyAuthRequired: keyAuthRequired === true,
          model,
          setModel,
          reasoningEffort,
          setReasoningEffort,
          latencyMode,
          setLatencyMode,
          inspectorOpen,
          setInspectorOpen,
          session,
          setSession,
          sessionChannelProjectionAuthority,
          sessionCreationHandoff,
          connectionState,
          setConnectionState,
          sessionEventFeedStore,
          manualRepos,
          setManualRepos,
          manualReposOpen,
          setManualReposOpen,
          selectedRepoIds,
          setSelectedRepoIds,
          selectedRepoRefs,
          setSelectedRepoRefs,
          githubRepos,
          githubStatus,
          githubStatusFailed,
          githubCatalogReady,
          personalGitHubStatus,
          personalGitHubRepositories,
          personalGitHubSelection,
          personalGitHubCatalogReady,
          personalGitHubBusy,
          selectedPersonalGitHubRepoIds,
          setSelectedPersonalGitHubRepoIds,
          selectedPersonalGitHubRepoRefs,
          setSelectedPersonalGitHubRepoRefs,
          personalGitHubAuthority,
          githubAppOpen,
          setGithubAppOpen,
          githubOrg,
          setGithubOrg,
          selectedCapabilityToolIds,
          setSelectedCapabilityToolIds,
          busy,
          repoBusy,
          githubAppBusy,
          selectedInstallationId,
          repositoryGroups,
          toolMcpServers,
          workspaceDefaultToolIds,
          workspaceMcpCatalogReady,
          workspaceCapabilityCatalog,
          currentResources,
          workspaceStateOwnerId,
          prepareWorkspaceTransition,
          captureWorkspaceInvocation,
          ownsWorkspaceInvocation,
          addManualRepository: contextAddManualRepository,
          forgetAccessKey: contextForgetAccessKey,
          handleManagedSignOut: contextHandleManagedSignOut,
          revalidatePrincipalAccess,
          createWorkspace: contextCreateWorkspace,
          renameWorkspace: contextRenameWorkspace,
          setWorkspaceInferenceControl: contextSetWorkspaceInferenceControl,
          refreshWorkspace,
          updateWorkspaceSettings: contextUpdateWorkspaceSettings,
          setWorkspaceDefaultRig: contextSetWorkspaceDefaultRig,
          updateSessionTitle: contextUpdateSessionTitle,
          updateSessionPin: contextUpdateSessionPin,
          deleteWorkspace: contextDeleteWorkspace,
          refreshGitHub,
          refreshPersonalGitHub,
          connectPersonalGitHub: contextConnectPersonalGitHub,
          reconnectPersonalGitHub: contextReconnectPersonalGitHub,
          disconnectPersonalGitHub: contextDisconnectPersonalGitHub,
          savePersonalGitHubRepositories: contextSavePersonalGitHubRepositories,
          ensurePersonalGitHubAuthority: contextEnsurePersonalGitHubAuthority,
          togglePersonalGitHubRepository: contextTogglePersonalGitHubRepository,
          refreshWorkspaceMcpServers,
          startGitHubAppManifestFlow: contextStartGitHubAppManifestFlow,
          disconnectGitHubInstallation: contextDisconnectGitHubInstallation,
          toggleGitHubRepository: contextToggleGitHubRepository,
          startSession: contextStartSession,
          resetSessionView,
          resetWorkspaceIntegrations,
        } satisfies AppContextValue)
      : null;
  }, [
    accessContext,
    accessKeyVersion,
    authSession,
    busy,
    captureWorkspaceInvocation,
    clearSlackLinkContinuation,
    client,
    clientConfig,
    connectionState,
    contextAddManualRepository,
    contextCreateWorkspace,
    contextDeleteWorkspace,
    contextConnectPersonalGitHub,
    contextDisconnectPersonalGitHub,
    contextEnsurePersonalGitHubAuthority,
    contextForgetAccessKey,
    contextHandleManagedSignOut,
    contextRenameWorkspace,
    contextReconnectPersonalGitHub,
    contextSavePersonalGitHubRepositories,
    contextSetWorkspaceInferenceControl,
    contextSetWorkspaceDefaultRig,
    contextDisconnectGitHubInstallation,
    contextStartGitHubAppManifestFlow,
    contextStartSession,
    contextToggleGitHubRepository,
    contextTogglePersonalGitHubRepository,
    contextUpdateSessionPin,
    contextUpdateSessionTitle,
    contextUpdateWorkspaceSettings,
    currentResources,
    githubAppBusy,
    githubAppOpen,
    githubOrg,
    githubRepos,
    githubStatus,
    githubStatusFailed,
    personalGitHubStatus,
    personalGitHubRepositories,
    personalGitHubSelection,
    personalGitHubCatalogReady,
    personalGitHubBusy,
    selectedPersonalGitHubRepoIds,
    selectedPersonalGitHubRepoRefs,
    personalGitHubAuthority,
    githubCatalogReady,
    inspectorOpen,
    invalidSlackLinkQueryWorkspaceId,
    keyAuthRequired,
    manualRepos,
    manualReposOpen,
    managedSelfContext,
    model,
    ownsWorkspaceInvocation,
    preparePendingSlackLink,
    prepareWorkspaceTransition,
    slackLinkContinuationWorkspaceId,
    latencyMode,
    reasoningEffort,
    revalidatePrincipalAccess,
    refreshGitHub,
    refreshPersonalGitHub,
    refreshWorkspace,
    refreshWorkspaceMcpServers,
    repoBusy,
    repositoryGroups,
    resetSessionView,
    resetWorkspaceIntegrations,
    selectedCapabilityToolIds,
    selectedInstallationId,
    selectedRepoIds,
    selectedRepoRefs,
    session,
    sessionChannelProjectionAuthority,
    sessionCreationHandoff,
    sessionEventFeedStore,
    setSession,
    toolMcpServers,
    workspaceDefaultToolIds,
    workspaceMcpCatalogReady,
    workspaceCapabilityCatalog,
    workspaceStateOwnerId,
    workspaces,
  ]);

  const applicationSurface = isPublicAuthRoute ? (
    // Self-contained public pages render before config/auth gates and outside
    // AppContext. The isolated account-auth popup is intentionally included.
    <Outlet />
  ) : !clientConfig && !configError ? (
    <LoadingPanel label="Loading OpenGeni" />
  ) : configError ? (
    <ProblemPanel title="Client configuration unavailable" description={configError} />
  ) : keyAuthRequired && !hasAccessKey ? (
    <AccessKeyPanel
      authMode={clientConfig?.auth.mode}
      accessKeyDraft={accessKeyDraft}
      setAccessKeyDraft={setAccessKeyDraft}
      onSubmit={saveAccessKey}
    />
  ) : managedAuthRequired && authSession === undefined ? (
    <LoadingPanel label="Checking session" />
  ) : managedAuthRequired && !authSession ? (
    <Suspense fallback={<LoadingPanel label="Loading sign in" />}>
      {browserAccountsEnabled ? (
        <BrowserAccountsSignedOutPanel
          emptySetRegistrationPanel={
            clientConfig?.managedAuthSessionSetMode === "broker" ||
            clientConfig?.managedAuthSessionSetMode === "dual" ? (
              <ManagedAuthPanel
                initialMode="signup"
                allowedModes={["signup"]}
                presentation="embedded"
                onSubmit={async (_mode, input) => await handleManagedSessionSetSignup(input)}
                emailVerificationRequired={managedEmailVerificationRequired}
              />
            ) : undefined
          }
        />
      ) : (
        <ManagedAuthPanel
          onSubmit={handleManagedAuth}
          emailVerificationRequired={managedEmailVerificationRequired}
          socialProviders={managedSocialProviders}
          onSocialSubmit={handleManagedSocialAuth}
        />
      )}
    </Suspense>
  ) : accessError && !accessLoading ? (
    <ProblemPanel
      title="Workspace access unavailable"
      description={accessError}
      action={
        <Button
          type="button"
          variant="secondary"
          onClick={() => setAccessKeyVersion((version) => version + 1)}
        >
          Retry
        </Button>
      }
    />
  ) : managedAuthRequired &&
    !accessLoading &&
    accessContext &&
    !defaultWorkspaceId &&
    !slackLinkContinuationWorkspaceId ? (
    <OrganizationOnboardingPanel client={client} onComplete={revalidatePrincipalAccess} />
  ) : accessLoading || !appContext ? (
    <LoadingPanel label="Loading workspace access" />
  ) : !defaultWorkspaceId && !slackLinkContinuationWorkspaceId ? (
    <ProblemPanel
      title="No workspace access"
      description="You don't have access to any workspace yet."
    />
  ) : (
    <AppContext.Provider value={appContext}>
      <Outlet />
      {import.meta.env.DEV && import.meta.env.VITE_OPENGENI_ROUTER_DEVTOOLS === "true" ? (
        <TanStackRouterDevtools position="bottom-right" />
      ) : null}
    </AppContext.Provider>
  );

  const actorFencedSurface =
    browserAccountsEnabled && !isPublicAuthRoute ? (
      <Suspense fallback={<LoadingPanel label="Loading browser accounts" />}>
        <BrowserAccountsRuntime
          bootstrapLegacySession={
            clientConfig?.managedAuthSessionSetMode === "dual" && Boolean(authSession)
          }
          mutationBusy={busy || repoBusy || githubAppBusy || pendingCreateAttempt.current !== null}
          onActorTransition={contextHandleBrowserActorTransition}
        >
          <BrowserAccountsLoadingGate>{applicationSurface}</BrowserAccountsLoadingGate>
        </BrowserAccountsRuntime>
      </Suspense>
    ) : (
      applicationSurface
    );

  return (
    // Fixed app canvas: never let the document scroll. Page surfaces own
    // overflow via ContentPage / session panes. `min-h-screen` used to let
    // main grow past the viewport when a child mis-owned scroll.
    <main className="flex h-dvh max-h-dvh flex-col overflow-hidden bg-bg text-fg">
      <Toaster />
      {clientConfig ? (
        <Suspense fallback={null}>
          <AnalyticsManager
            analyticsAccountId={accessContext?.defaultAccountId ?? null}
            analyticsUserId={authSession?.user.id ?? null}
            config={clientConfig.analytics}
            hasSearchParameters={hasSearchParameters}
            isPublicAuthRoute={isPublicAuthRoute}
            pathname={pathname}
          />
        </Suspense>
      ) : null}
      {clientConfig ? (
        <SecureContextWarning productAccessMode={clientConfig.productAccessMode} />
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{actorFencedSurface}</div>
    </main>
  );
}

function submitGitHubManifest(actionUrl: string, manifest: Record<string, unknown>): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = actionUrl;
  form.style.display = "none";
  form.acceptCharset = "utf-8";

  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = JSON.stringify(manifest);

  form.append(input);
  document.body.append(form);
  form.submit();
}

export function pendingSlackLinkFromUrl(value: string): PendingSlackLink | null {
  const url = new URL(value, "https://opengeni.invalid");
  const match = /^\/workspaces\/([^/]+)\/capabilities\/?$/.exec(url.pathname);
  if (!match?.[1]) return null;
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const token = fragment.get("slack_link");
  if (!token || token.length > 2_048) return null;
  return { workspaceId: decodeURIComponent(match[1]), token };
}

export function invalidSlackLinkQueryWorkspaceIdFromUrl(value: string): string | null {
  const url = new URL(value, "https://opengeni.invalid");
  const match = /^\/workspaces\/([^/]+)\/capabilities\/?$/.exec(url.pathname);
  return match?.[1] && url.searchParams.has("slack_link") ? decodeURIComponent(match[1]) : null;
}

function pendingSlackLinkFromBrowserLocation(): PendingSlackLink | null {
  return typeof window === "undefined" ? null : pendingSlackLinkFromUrl(window.location.href);
}

function stripSlackLinkFromBrowserLocation(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const queryHasSlackLink = url.searchParams.has("slack_link");
  const rawFragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const fragment = new URLSearchParams(rawFragment);
  const fragmentHasSlackLink = fragment.has("slack_link");
  if (!queryHasSlackLink && !fragmentHasSlackLink) return;
  url.searchParams.delete("slack_link");
  if (fragmentHasSlackLink) {
    fragment.delete("slack_link");
    const nextFragment = fragment.toString();
    url.hash = nextFragment ? `#${nextFragment}` : "";
  }
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function AccessKeyPanel(props: {
  authMode: ClientConfig["auth"]["mode"] | undefined;
  accessKeyDraft: string;
  setAccessKeyDraft: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <section className="flex flex-1 items-center justify-center px-4">
      <form
        className="w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit();
        }}
      >
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <LockIcon className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold">Access key required</h1>
            <p className="text-sm text-fg-subtle">
              Enter the{" "}
              {props.authMode === "configuredToken" ? "configured bearer token" : "deployment key"}{" "}
              for this OpenGeni instance.
            </p>
          </div>
        </div>
        <Label htmlFor="access-key">Access key</Label>
        <Input
          id="access-key"
          type="password"
          value={props.accessKeyDraft}
          onChange={(event) => props.setAccessKeyDraft(event.target.value)}
          autoComplete="current-password"
          className="mt-2"
          autoFocus
        />
        <Button
          type="submit"
          className="mt-4 w-full"
          disabled={props.accessKeyDraft.trim().length === 0}
        >
          <CheckIcon className="size-4" />
          Continue
        </Button>
      </form>
    </section>
  );
}
