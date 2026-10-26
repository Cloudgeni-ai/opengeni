// The session UI's app state: client configuration, the signed-in principal
// and its workspace access, and the cross-route console state (model choice,
// repository and tool selection, the open session and its event feed, session
// creation). Every host renders the session UI on top of this one state
// machine: the web app with its own sign-in (`authority: "app"`), embeds with a
// client the embedding page already authenticated (`authority: "host"`).
import { t } from "./lib/console-text";
import {
  createSessionEventFeedStore,
  useLatestCallback,
  type AppContextValue,
  type PendingSlackLink,
  type SessionCreationHandoff,
} from "./app-context";
import { startWorkspaceVoiceCapabilityRefresh } from "./lib/workspace-voice-capability";
import { markIntegrationConnectRedirect } from "./lib/integration-connect-redirect";
import { userErrorText } from "../ui/api-error";
import {
  hasWorkspacePermission,
  isWorkspacePermissionDenied,
  lacksWorkspacePermission,
} from "./lib/permissions";
import { creationHandoffReconciled } from "./lib/session-creation-handoff";
import { useConsoleSharedQueries } from "./lib/shared-query";
import { useNavigate, usePage, useRouterState } from "./lib/navigation";
import { useEmbedded, useHostMessageContext } from "./lib/app-host";
import {
  resolveWorkspaceSessionDefaults,
  resolveWorkspaceSessionToolDefaults,
} from "@opengeni/contracts";
import type {
  McpConnectionAccountSelection,
  PersonalGitHubRepositorySelectionInput,
} from "@opengeni/sdk";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { composerSubmissionErrorMessage } from "../lib/format";
import { claimHumanInputDraftOwner, forgetAllHumanInputDrafts } from "../human-input-draft-store";
import type { SessionEventsConnectionState } from "../hooks/use-session-events";
import type { BrowserAccountTransition } from "../accounts";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { toast } from "./lib/toast";
import type { AnalyticsEventName, AnalyticsProperties } from "./lib/analytics-types";
import {
  bootstrapErrorPresentation,
  bootstrapWaitingPresentation,
  type BootstrapErrorPresentation,
} from "./lib/bootstrap-error";
import { readBootstrap } from "./lib/bootstrap-read";
import { startDeploymentRefresh } from "./lib/deployment-refresh";
import {
  ManagedAuthSessionUnavailableError,
  signOutWithAuthoritativeReconciliation,
} from "./lib/managed-auth-transition";
import { unlinkGitHubInstallationWithReconciliation } from "./lib/github-installation-unlink";
import {
  beginSocialLoginAnalytics,
  noteSuccessfulLogin,
  observeSocialLoginResult,
} from "./lib/analytics-login";
import {
  loadCurrentManagedSelfContext,
  managedSelfContextIdentity,
  type ManagedSelfContext,
  type ManagedSelfContextIdentity,
} from "./lib/managed-self-context";
import { sameSessionForContext } from "./lib/session-context";
import { runSingleFlight } from "./lib/single-flight";
import {
  buildCreateSessionRequest,
  classifyCreateSessionFailure,
  prepareCreateSessionAttempt,
  retainCreateSessionAttemptAfterFailure,
  type PendingCreateAttempt,
} from "./lib/session-create";
import { isPaymentRequiredError } from "./lib/model-access";
import {
  applySessionPinProjection,
  notifySessionPinChanged,
  reconcileFailedSessionPin,
  SessionChannelProjectionAuthority,
} from "./lib/session-pins";
import {
  isAuthorizedWorkspaceId,
  workspaceNavigationPreferenceStorageId,
  writeLastWorkspaceId,
  writeLastWorkspaceIdForOrganization,
  organizationWorkspacePreferenceStorageId,
} from "./lib/workspace-navigation-preference";
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
  type IntelligenceEffort,
  type McpServerOption,
  type RepoDraft,
} from "./lib/session-tools";
import { useCapabilityToolDefaults } from "./lib/use-capability-tool-defaults";
import { useManualRepositoryCatalogReconciliation } from "./lib/use-manual-repository-catalog-reconciliation";
import { upsertWorkspace } from "./lib/workspaces";
import { deleteWorkspaceWithReconciliation } from "./lib/workspace-deletion";
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
} from "./lib/workspace-transition";
import {
  reusablePersonalGitHubAuthority,
  type PersonalGitHubAuthorityCache,
} from "./lib/personal-github-authority";
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
  TurnSubmission,
  UpdateWorkspaceSettingsRequest,
  Workspace,
} from "./types";

/**
 * Transport and sign-in functions the app state calls. Pass one stable object
 * (a module constant): its functions are read once per render.
 */
export type AppStateHost = Readonly<{
  /**
   * "app": the app owns sign-in (deployment key, configured token or managed
   * session, as the server's client configuration says). "host": the
   * embedding page already authenticated `createOpenGeniClient`'s client, so
   * no sign-in step or access-key gate runs.
   */
  authority: "app" | "host";
  createOpenGeniClient: (beginSharedRead?: () => number) => OpenGeniBrowserClient;
  fetchClientConfig: (signal?: AbortSignal, workspaceId?: string) => Promise<ClientConfig>;
  /** Product analytics for sign-in and sign-up outcomes. */
  captureProductEvent: (name: AnalyticsEventName, properties?: AnalyticsProperties) => void;
  /** Re-checks the deployed revision on focus and on an interval; absent: never. */
  checkDeploymentRevision?: ((signal: AbortSignal) => Promise<void>) | undefined;
  // Sign-in for `authority: "app"`; hosts with `authority: "host"` never reach them.
  fetchAuthSession: () => Promise<AuthSession | null>;
  signInEmail: (input: {
    email: string;
    password: string;
    rememberMe?: boolean;
  }) => Promise<unknown>;
  signUpEmail: (input: {
    name: string;
    email: string;
    password: string;
    signupChallengeToken?: string;
  }) => Promise<unknown>;
  signOutManaged: () => Promise<unknown>;
  startManagedSocialSignIn: (
    provider: "google" | "github",
    signupChallengeToken?: string,
  ) => Promise<void>;
  configureManagedActorEpoch: (epoch: string | null) => void;
  getStoredAccessKey: () => string | null;
  setStoredAccessKey: (value: string) => void;
  clearStoredAccessKey: () => void;
  /** A signed Slack link the page opened with, exchanged once after sign-in. */
  slackLink: SlackLinkPrepareController<SlackUserLinkAccessRequest>;
  initialInvalidSlackLinkQueryWorkspaceId: string | null;
}>;

export type AppStateOptions = Readonly<{
  /** Skip the client-configuration bootstrap (public pages that need no session). */
  bootstrapSuspended: boolean;
}>;

export type AppState = ReturnType<typeof useAppState>;

type StartSessionOptions = Parameters<AppContextValue["startSession"]>[2];

export type SlackLinkPrepareController<Request> = ReturnType<
  typeof createSlackLinkPrepareController<Request>
>;

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

export function useAppState(host: AppStateHost, appStateOptions: AppStateOptions) {
  const messageContext = useHostMessageContext();
  const embedded = useEmbedded();
  const hostMessageContext = useRef(messageContext);
  hostMessageContext.current = messageContext;
  const {
    captureProductEvent,
    checkDeploymentRevision,
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
    slackLink,
  } = host;
  const [session, setSessionState] = useState<Session | null>(null);
  const [sessionChannelProjectionAuthority] = useState(
    () => new SessionChannelProjectionAuthority(),
  );
  const [sessionCreationHandoff, setSessionCreationHandoff] =
    useState<SessionCreationHandoff | null>(null);
  const [clientConfig, setClientConfig] = useState<ClientConfig | null>(null);
  const [workspaceVoiceInput, setWorkspaceVoiceInput] =
    useState<ClientConfig["voiceInput"]>(undefined);
  const [configError, setConfigError] = useState<BootstrapErrorPresentation | null>(null);
  const [configRequestVersion, setConfigRequestVersion] = useState(0);
  const [authSession, setAuthSession] = useState<AuthSession | null | undefined>(undefined);
  const [managedAuthBootstrapComplete, setManagedAuthBootstrapComplete] = useState(false);
  const [accessContext, setAccessContext] = useState<AccessContext | null>(null);
  const accessContextRef = useRef(accessContext);
  useInsertionEffect(() => {
    accessContextRef.current = accessContext;
  }, [accessContext]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [managedSelfContext, setManagedSelfContext] = useState<ManagedSelfContext | null>(null);
  const [slackLinkContinuationWorkspaceId, setSlackLinkContinuationWorkspaceId] = useState<
    string | null
  >(slackLink.workspaceId);
  const [invalidSlackLinkQueryWorkspaceId, setInvalidSlackLinkQueryWorkspaceId] = useState<
    string | null
  >(host.initialInvalidSlackLinkQueryWorkspaceId);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState<BootstrapErrorPresentation | null>(null);
  const [creditRequired, setCreditRequired] = useState<{
    workspaceId: string;
    accountId: string | null;
  } | null>(null);
  const [model, setModel] = useState("gpt-6-astra");
  const [reasoningEffort, setReasoningEffort] = useState<IntelligenceEffort>("low");
  const [latencyMode, setLatencyMode] = useState<LatencyMode>("standard");
  // Changes/Files dock starts collapsed; user opens via the session-panel toggle.
  // No localStorage — only an in-memory default (toggle still works for the session).
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [connectionState, setConnectionState] = useState<SessionEventsConnectionState>("idle");
  const [sessionEventFeedStore] = useState(createSessionEventFeedStore);
  useEffect(() => {
    const retireReconciledCreation = () => {
      const feed = sessionEventFeedStore.getSnapshot();
      if (!feed) return;
      setSessionCreationHandoff((current) =>
        creationHandoffReconciled(current, feed.events) ? null : current,
      );
    };
    retireReconciledCreation();
    return sessionEventFeedStore.subscribe(retireReconciledCreation);
  }, [sessionEventFeedStore]);
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
  const [workspaceMcpCatalogLoadedSuccessfully, setWorkspaceMcpCatalogLoadedSuccessfully] =
    useState(false);
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
  // Every default-enabled tool is selected when it first appears. Explicit
  // deselections survive subsequent catalog refreshes.
  const seenCapabilityToolIds = useRef<Set<string>>(new Set());
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
    host.authority === "app" &&
    (clientConfig?.auth.mode === "deploymentKey" || clientConfig?.auth.mode === "configuredToken");
  const managedAuthRequired =
    host.authority === "app" && clientConfig?.auth.mode === "managedSession";
  const browserAccountsConfigured =
    managedAuthRequired && clientConfig?.managedAuthSessionSetMode !== "legacy";
  const browserAccountsEnabled = browserAccountsConfigured && managedAuthBootstrapComplete;
  const managedEmailVerificationRequired =
    clientConfig?.auth.mode === "managedSession"
      ? (clientConfig.auth.emailVerificationRequired ?? true)
      : true;
  const managedSocialProviders =
    clientConfig?.auth.mode === "managedSession" ? (clientConfig.auth.socialProviders ?? []) : [];
  // An older API omits the field; only an explicit false pauses account creation.
  const managedNewSignupsEnabled =
    clientConfig?.auth.mode === "managedSession"
      ? clientConfig.auth.newSignupsEnabled !== false
      : true;
  const keyAuthReady = !keyAuthRequired || hasAccessKey;
  const managedAuthReady = !managedAuthRequired || Boolean(authSession);
  const authReady = keyAuthReady && managedAuthReady;
  const defaultWorkspaceId =
    accessContext?.defaultWorkspaceId ??
    workspaces[0]?.id ??
    accessContext?.workspaceGrants[0]?.workspaceId ??
    null;
  const navigate = useNavigate();
  const hostPage = usePage();

  // Public routes render ahead of every auth/config gate: a user completing a
  // password reset is signed out by definition, so `/reset-password` must never
  // be intercepted by the sign-in panel or workspace-access loading.
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  useEffect(() => {
    if (!browserAccountsConfigured) configureManagedActorEpoch(null);
    return () => configureManagedActorEpoch(null);
  }, [browserAccountsConfigured, configureManagedActorEpoch]);
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
  }, [accessKeyVersion, createOpenGeniClient, sessionChannelProjectionAuthority]);
  // Account lists and usage limits read through this client stay across
  // navigation and are cleared with it when an identity change replaces it;
  // "Available in" changes re-read them.
  useConsoleSharedQueries(client);
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
    setWorkspaceMcpCatalogLoadedSuccessfully(false);
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
      seenCapabilityToolIds.current = new Set();
      appliedWorkspaceToolDefaultsKey.current = null;
      setGithubAppOpen(false);
      setGithubOrg("");
      setBusy(false);
      setRepoBusy(false);
      setGithubAppBusy(false);
      setPersonalGitHubBusy(false);
      resetWorkspaceIntegrations();
      setWorkspaceVoiceInput(undefined);
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

  const clientConfigurationReady = clientConfig !== null;
  useEffect(() => {
    if (!clientConfigurationReady || !authReady || !workspaceStateOwnerId) return;
    const workspaceId = workspaceStateOwnerId;
    const accepted = captureWorkspaceInvocation(workspaceId);
    if (!accepted) return;
    return startWorkspaceVoiceCapabilityRefresh({
      read: (signal) => fetchClientConfig(signal, workspaceId),
      ownsWorkspace: () => ownsWorkspaceInvocation(workspaceId, accepted),
      apply: (voiceInput) => setWorkspaceVoiceInput(voiceInput),
      subscribeFocus: (refresh) => {
        window.addEventListener("focus", refresh);
        return () => window.removeEventListener("focus", refresh);
      },
    });
  }, [
    fetchClientConfig,
    clientConfigurationReady,
    authReady,
    workspaceStateOwnerId,
    accessContext?.subjectId,
    accessKeyVersion,
    captureWorkspaceInvocation,
    ownsWorkspaceInvocation,
  ]);

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
        slackLink.clear();
        setSlackLinkContinuationWorkspaceId(null);
      }
      resetWorkspaceState(null, true);
    },
    [resetWorkspaceState, slackLink],
  );

  useEffect(() => {
    if (appStateOptions.bootstrapSuspended) return;
    let cancelled = false;
    let stopDeploymentRefresh = () => {};
    const controller = new AbortController();
    // Let synchronous effect cleanup (including StrictMode's discarded mount)
    // cancel before starting I/O. Active requests still abort on real cleanup.
    void Promise.resolve()
      .then(() =>
        readBootstrap({
          context: "client_configuration",
          request: () => fetchClientConfig(controller.signal),
          signal: controller.signal,
          // An update parks the API for a while: say so calmly and continue
          // on our own as soon as it answers.
          waiting: {
            onWaiting: (error, elapsedMs) => {
              if (!cancelled) {
                setConfigError(
                  bootstrapWaitingPresentation(error, "client_configuration", elapsedMs),
                );
              }
            },
          },
        }),
      )
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
        if (checkDeploymentRevision) {
          stopDeploymentRefresh = startDeploymentRefresh(checkDeploymentRevision);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const presentation = bootstrapErrorPresentation(error, "client_configuration");
        setConfigError(presentation);
      });
    return () => {
      cancelled = true;
      controller.abort();
      stopDeploymentRefresh();
    };
  }, [
    checkDeploymentRevision,
    configRequestVersion,
    fetchClientConfig,
    appStateOptions.bootstrapSuspended,
  ]);

  useEffect(() => {
    if (!clientConfig) {
      setManagedAuthBootstrapComplete(false);
      return;
    }
    if (!managedAuthRequired) {
      if (authPrincipalIdRef.current !== null) {
        invalidatePrincipalWorkspaceState();
      }
      setAuthSession(null);
      setManagedAuthBootstrapComplete(true);
      return;
    }
    let cancelled = false;
    const acceptedPrincipal = principalTransitionIdentity.current;
    const controller = new AbortController();
    setManagedAuthBootstrapComplete(false);
    setAuthSession(undefined);
    // During an update the session read fails transiently. That is not
    // "signed out": keep waiting calmly and continue when the API answers.
    void readBootstrap({
      context: "client_configuration",
      request: fetchAuthSession,
      signal: controller.signal,
      waiting: {
        onWaiting: (error, elapsedMs) => {
          if (!cancelled) {
            setConfigError(bootstrapWaitingPresentation(error, "client_configuration", elapsedMs));
          }
        },
      },
    })
      .then((nextSession) => {
        if (
          cancelled ||
          !ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal)
        ) {
          return;
        }
        setConfigError((current) => (current?.recovering ? null : current));
        const nextPrincipalId = nextSession?.user.id ?? null;
        if (authPrincipalIdRef.current !== null && authPrincipalIdRef.current !== nextPrincipalId) {
          invalidatePrincipalWorkspaceState();
        }
        authPrincipalIdRef.current = nextPrincipalId;
        observeSocialLoginResult(nextSession);
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
        setConfigError((current) => (current?.recovering ? null : current));
        setAuthSession(null);
        setManagedAuthBootstrapComplete(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [clientConfig, fetchAuthSession, managedAuthRequired, invalidatePrincipalWorkspaceState]);

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
      managedAuthRequired && authSession
        ? managedSelfContextIdentity({
            credentialGeneration: accessKeyVersion,
            managedUserId: authSession.user.id,
          })
        : null;
    managedSelfContextIdentityRef.current = acceptedManagedIdentity;
    setManagedSelfContext(null);
    setAccessLoading(true);
    // A calm waiting state stays up while a retry runs.
    setAccessError((current) => (current?.recovering ? current : null));
    const controller = new AbortController();
    // These SDK reads do not accept a caller signal. Fence their late results
    // and every new attempt without changing the SDK's general retry policy.
    const readAccess = <T,>(request: () => Promise<T>) =>
      readBootstrap({
        context: "workspace_access",
        request,
        signal: controller.signal,
        isCurrent: () =>
          ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal),
        waiting: {
          onWaiting: (error, elapsedMs) => {
            if (
              !cancelled &&
              ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal)
            ) {
              setAccessError(bootstrapWaitingPresentation(error, "workspace_access", elapsedMs));
            }
          },
        },
      });
    const selfContextPromise = acceptedManagedIdentity
      ? loadCurrentManagedSelfContext({
          identity: acceptedManagedIdentity,
          currentIdentity: () => managedSelfContextIdentityRef.current,
          request: () => readAccess(() => client.listOrganizationMemberships()),
        })
      : Promise.resolve(null);
    void Promise.all([
      readAccess(() => client.getAccessContext()),
      readAccess(() => client.listWorkspaces()),
      selfContextPromise,
    ])
      .then(([context, nextWorkspaces, nextManagedSelfContext]) => {
        if (
          cancelled ||
          !ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal)
        ) {
          return;
        }
        // The API answered: any calm "reconnecting" state is over.
        setAccessError((current) => (current?.recovering ? null : current));
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
        // Unsent answers to agent questions belong to this tab's principal: a
        // different one forgets them before any session route can render.
        claimHumanInputDraftOwner(context.subjectId);
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
        const presentation = bootstrapErrorPresentation(error, "workspace_access");
        controller.abort();
        setAccessContext(null);
        setWorkspaces([]);
        setAccessError(presentation);
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
      controller.abort();
    };
  }, [
    accessKeyVersion,
    authSession,
    clientConfig,
    authReady,
    client,
    managedAuthRequired,
    invalidatePrincipalWorkspaceState,
  ]);

  // The workspace URL remains authoritative. This browser-local preference is
  // only the landing target for a future visit to `/`, and is namespaced by the
  // current subject so browser-account transitions cannot inherit each other's
  // workspace selection.
  useEffect(() => {
    if (!accessContext) return;
    const workspaceId = /^\/workspaces\/([^/]+)/.exec(pathname)?.[1] ?? null;
    if (!isAuthorizedWorkspaceId(workspaceId, workspaces, accessContext)) return;
    writeLastWorkspaceId(
      workspaceNavigationPreferenceStorageId(accessContext.subjectId),
      workspaceId,
    );
    // Switching back to this organization returns to this workspace.
    const accountId = workspaces.find((workspace) => workspace.id === workspaceId)?.accountId;
    if (accountId) {
      writeLastWorkspaceIdForOrganization(
        organizationWorkspacePreferenceStorageId(accessContext.subjectId),
        accountId,
        workspaceId,
      );
    }
  }, [accessContext, pathname, workspaces]);

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
      ? [
          ...new Set([
            ...configured.filter((id) => available.has(id)),
            ...(configuredWorkspaceToolDefaults?.inheritConnectedMcpServers
              ? toolMcpServers
                  .filter((server) => !["opengeni", "files", "docs"].includes(server.id))
                  .map((server) => server.id)
              : []),
          ]),
        ]
      : toolMcpServers.map((server) => server.id);
  }, [configuredWorkspaceToolDefaults, toolMcpServers]);
  const lastValidResources = useRef<ResourceRef[]>([]);
  const repositoryBuild = useMemo(() => {
    try {
      return {
        resources: buildResources(
          manualRepos,
          githubRepos,
          selectedRepoIds,
          selectedRepoRefs,
          personalGitHubRepositories,
          selectedPersonalGitHubRepoIds,
          selectedPersonalGitHubRepoRefs,
          personalGitHubSelection?.credentialBindingId ?? null,
        ),
        error: null,
      };
    } catch (error) {
      return {
        resources: lastValidResources.current,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [
    manualRepos,
    githubRepos,
    selectedRepoIds,
    selectedRepoRefs,
    personalGitHubRepositories,
    selectedPersonalGitHubRepoIds,
    selectedPersonalGitHubRepoRefs,
    personalGitHubSelection?.credentialBindingId,
  ]);
  useEffect(() => {
    if (!repositoryBuild.error) lastValidResources.current = repositoryBuild.resources;
  }, [repositoryBuild]);
  useManualRepositoryCatalogReconciliation({
    manualRepos,
    selectedRepoIds,
    selectedRepoRefs,
    repositories: githubRepos,
    catalogReady: githubCatalogReady,
    personalRepositories: personalGitHubRepositories,
    selectedPersonalRepoIds: selectedPersonalGitHubRepoIds,
    selectedPersonalRepoRefs: selectedPersonalGitHubRepoRefs,
    setManualRepos,
    setSelectedRepoIds,
    setSelectedRepoRefs,
  });
  const currentResources = repositoryBuild.resources;
  const repositoryValidationError = repositoryBuild.error;

  useCapabilityToolDefaults({
    principalKey: JSON.stringify(principalTransitionIdentity.current),
    ready: clientConfig !== null && !/^\/workspaces\/[^/]+\/sessions\/?$/.test(pathname),
    workspaceId: routedWorkspaceId,
    configuredIds: configuredWorkspaceToolDefaults?.mcpServerIds,
    availableIds: toolMcpServers.map((server) => server.id),
    defaultIds: workspaceDefaultToolIds,
    appliedKey: appliedWorkspaceToolDefaultsKey,
    seenIds: seenCapabilityToolIds,
    setSelected: setSelectedCapabilityToolIds,
  });

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
        description: userErrorText(error),
      });
      return null;
    }
    setWorkspaces((current) => upsertWorkspace(current, created));
    captureProductEvent("workspace_created", {
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
      claimHumanInputDraftOwner(accessRefresh.value.subjectId);
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
        description: userErrorText(error),
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
        description: userErrorText(error),
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
      toast.error("Failed to update the workspace default sandbox environment", {
        description: userErrorText(error),
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
        description: userErrorText(error),
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
          description: userErrorText(error),
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
        request: async () =>
          await deleteWorkspaceWithReconciliation({
            deleteWorkspace: async () => await client.deleteWorkspace(workspaceId),
            readWorkspace: async () => await client.getWorkspace(workspaceId),
          }),
      });
      if (deletion.status === "stale") return false;
    } catch (error) {
      toast.error("Failed to delete workspace", {
        description: userErrorText(error),
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
      claimHumanInputDraftOwner(accessRefresh.value.subjectId);
      setAccessContext(accessRefresh.value);
    } catch {
      toast.warning("Permissions may be out of date", {
        description: "Reload if something looks off.",
      });
    }
    return true;
  }

  const refreshGitHub = useCallback(
    async (workspaceId: string, signal?: AbortSignal, options?: { sync?: boolean | undefined }) => {
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
      // A member whose loaded grant lacks GitHub has no GitHub state to read.
      if (lacksWorkspacePermission(accessContextRef.current, workspaceId, "github:use")) {
        setGithubStatus(null);
        setGithubStatusFailed(false);
        setGithubAppOpen(false);
        setGithubRepos([]);
        setGithubCatalogReady(true);
        setRepoBusy(false);
        return;
      }
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
          // Opengeni's cached rows.
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
        // Someone without GitHub access in this workspace has nothing to fix.
        if (isWorkspacePermissionDenied(error)) return;
        toast.error("GitHub status unavailable", {
          description: userErrorText(error),
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
      if (!hasWorkspacePermission(accessContextRef.current, workspaceId, "connections:read")) {
        setPersonalGitHubStatus(null);
        setPersonalGitHubRepositories([]);
        setPersonalGitHubSelection(null);
        setPersonalGitHubAuthorityCache(null);
        setSelectedPersonalGitHubRepoIds(new Set());
        setSelectedPersonalGitHubRepoRefs({});
        setPersonalGitHubCatalogReady(true);
        setPersonalGitHubBusy(false);
        return;
      }
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
          description: userErrorText(error),
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
      const attempt = await client.beginConnect(workspaceId, {
        providerId: "github-personal",
        ownership: "personal",
        returnUrl: hostPage.href(),
        idempotencyKey: crypto.randomUUID(),
        ...(reconnect && connection ? { reconnectAccountId: connection.id } : {}),
      });
      if (attempt.nextAction.type !== "authorize")
        throw new Error("GitHub did not return an authorization link");
      // The exact-return Connect redirect carries no outcome parameters.
      await markIntegrationConnectRedirect("github", "oauth", { returnsWithOutcome: false });
      hostPage.assign(attempt.nextAction.url);
    } catch (error) {
      toast.error("Couldn't open GitHub sign-in", {
        description: userErrorText(error),
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
        description: userErrorText(error),
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
        description: userErrorText(error),
      });
      return false;
    } finally {
      setPersonalGitHubBusy(false);
    }
  }

  async function ensurePersonalGitHubAuthority(
    _workspaceId: string,
  ): Promise<McpConnectionAccountSelection | null> {
    const connection = personalGitHubStatus?.connection;
    if (!connection?.authorityId || connection.status !== "active") {
      toast.error("Connect your GitHub account before selecting its repositories");
      return null;
    }
    const authority = { serverId: "github:personal", connectionId: connection.id };
    setPersonalGitHubAuthorityCache({ authority, connectionVersion: connection.version });
    return authority;
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
      setWorkspaceMcpCatalogLoadedSuccessfully(false);
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
        setWorkspaceMcpCatalogLoadedSuccessfully(true);
        setWorkspaceMcpCatalogReady(true);
      } catch (error) {
        if (signal?.aborted || mcpRefreshId.current !== refreshId) throw error;
        // Fail-open: an unavailable catalog must not leave the create composer
        // stuck on draft hydrate / canSend=false.
        setWorkspaceMcpCatalogLoadedSuccessfully(false);
        setWorkspaceMcpCatalogReady(true);
        throw error;
      }
    },
    [accessKeyVersion, client],
  );

  async function startSession(
    workspaceId: string,
    submission: TurnSubmission,
    options?: StartSessionOptions,
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
      if (repositoryValidationError) {
        toast.error("Fix repository details", { description: repositoryValidationError });
        return null;
      }
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
            connectionAccounts: [
              ...(submission.connectionAccounts ?? []).filter(
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
          installedSkillIds: options?.installedSkillIds,
          omitWorkspaceResources: options?.omitWorkspaceResources,
          selectedTools,
          newSessionDraftToolPolicy: options?.newSessionDraftToolPolicy,
          defaultModel: model,
          defaultReasoningEffort: reasoningEffort,
          defaultLatencyMode: latencyMode,
          clientEventId: crypto.randomUUID(),
          idempotencyKey: freshIdempotencyKey,
          workspaceDefaultMcpServerIds: workspaceDefaultToolIds,
          workspaceMcpCatalogReady,
          targetSandboxId: options?.targetSandboxId,
          workingDir: options?.workingDir,
          channelId: options?.channelId,
          expectedNewSessionDraftRevision: options?.expectedNewSessionDraftRevision,
          agentLearning: options?.agentLearning,
          startMode: options?.startMode,
          visibility: options?.visibility,
          usageLimitMicros: options?.usageLimitMicros,
        }),
      });
      attempted = attempt;
      pendingCreateAttempt.current = attempt.pending;
      // A voice start has no first message to carry the context; its first
      // spoken turn does.
      const hostContext =
        attempt.request.startMode === "realtime" ? undefined : hostMessageContext.current?.();
      const created = await client.createSession(
        workspaceId,
        hostContext ? { ...attempt.request, modelContext: hostContext } : attempt.request,
      );
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
      captureProductEvent("session_started", {
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
        const handled = attempted
          ? options?.onFailure?.({
              error: problem,
              request: attempted.request,
              outcomeUnknown,
            })
          : false;
        // A caller that handles the refusal shows it inline instead of the dialog.
        if (isPaymentRequiredError(problem) && handled !== true) {
          const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
          setCreditRequired({
            workspaceId,
            accountId: workspace?.accountId ?? null,
          });
        } else if (handled !== true) {
          toast.error("Failed to start session", {
            description: composerSubmissionErrorMessage(t, problem),
          });
        }
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
      submitGitHubManifest(result.value.actionUrl, result.value.manifest, embedded);
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
          description: userErrorText(error),
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
    const previousStatus = githubStatus;
    const previousRepositories = githubRepos;
    const previousSelectedIds = selectedRepoIds;
    const previousSelectedRefs = selectedRepoRefs;
    const removedRepositoryIds = new Set(
      githubRepos
        .filter((repository) => repository.installationId === installationId)
        .map((repository) => repository.id),
    );
    setGithubRepos((current) =>
      current.filter((repository) => repository.installationId !== installationId),
    );
    setGithubStatus((current) =>
      current
        ? {
            ...current,
            installations: current.installations.filter(
              (installation) => installation.installationId !== installationId,
            ),
          }
        : current,
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
    try {
      const unlink = await runCurrentWorkspaceOperation({
        activeOperation: () => activeGitHubDisconnectOperation.current,
        currentTransition: () => workspaceTransitionIdentity.current,
        operation,
        workspaceId,
        request: async () =>
          await unlinkGitHubInstallationWithReconciliation({
            installationId,
            unlink: async () => await client.unlinkGitHubInstallation(workspaceId, installationId),
            readStatus: async () => await client.getGitHubApp(workspaceId),
          }),
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
        setGithubStatus(previousStatus);
        setGithubRepos(previousRepositories);
        setSelectedRepoIds(previousSelectedIds);
        setSelectedRepoRefs(previousSelectedRefs);
        toast.error("Failed to unlink GitHub installation", {
          description: userErrorText(error),
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
    setManualRepos((current) => [
      ...current,
      { id: nextRepoId, url: "", ref: "main", attached: false },
    ]);
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
    input: { name: string; email: string; password: string; signupChallengeToken?: string },
  ) {
    invalidatePrincipalWorkspaceState({
      preservePendingSlackLink: preserveSlackLinkForManagedAuth(mode, slackLink.phase()),
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
      captureProductEvent("signup_submitted", {
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
    if (mode === "signin" && nextSession) noteSuccessfulLogin(nextSession.user.id, "email");
    setAuthSession(nextSession);
    setAccessKeyVersion((version) => version + 1);
  }

  async function handleManagedSessionSetSignup(input: {
    signupChallengeToken?: string;
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
    captureProductEvent("signup_submitted", {
      method: "email",
      verification_required: managedEmailVerificationRequired,
    });
  }

  async function handleManagedSocialAuth(
    provider: "google" | "github",
    signupChallengeToken?: string,
  ) {
    invalidatePrincipalWorkspaceState({
      preservePendingSlackLink: preserveSlackLinkForManagedAuth("signin", slackLink.phase()),
    });
    beginSocialLoginAnalytics(provider);
    await startManagedSocialSignIn(provider, signupChallengeToken);
  }

  async function handleManagedSignOut() {
    // Unmount authenticated readers before sign-out can invalidate their
    // cookie. Keep the neutral surface until an ambiguous response is
    // reconciled against the authoritative session.
    flushSync(() => {
      invalidatePrincipalWorkspaceState();
      setAuthSession(undefined);
      setAccessContext(null);
      setWorkspaces([]);
      setAccessError(null);
    });
    // The next person in this tab never sees this person's unsent answers.
    forgetAllHumanInputDrafts();
    const acceptedPrincipal = principalTransitionIdentity.current;
    const ownsInvocation = () =>
      ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal);
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
  // Onboarding may finish somewhere other than home (developer setup opens
  // its workspace's new chat); go there while access revalidates, so the app
  // opens on it. Resolves once the destination is the current location.
  const completeOrganizationOnboarding = useCallback(
    async (destination?: { workspaceId: string; sessionId?: string }) => {
      const arrived = destination?.sessionId
        ? navigate({
            to: "/workspaces/$workspaceId/sessions/$sessionId",
            params: { workspaceId: destination.workspaceId, sessionId: destination.sessionId },
          })
        : destination
          ? navigate({
              to: "/workspaces/$workspaceId/sessions",
              params: { workspaceId: destination.workspaceId },
            })
          : null;
      revalidatePrincipalAccess();
      await arrived;
    },
    [navigate, revalidatePrincipalAccess],
  );
  async function refreshPrincipalAccess(): Promise<boolean> {
    if (!clientConfig || !authReady) return false;
    let acceptedPrincipal = principalTransitionIdentity.current;
    const acceptedManagedIdentity =
      clientConfig.auth.mode === "managedSession" && authSession
        ? managedSelfContextIdentity({
            credentialGeneration: accessKeyVersion,
            managedUserId: authSession.user.id,
          })
        : null;
    managedSelfContextIdentityRef.current = acceptedManagedIdentity;
    const selfContextPromise = acceptedManagedIdentity
      ? loadCurrentManagedSelfContext({
          identity: acceptedManagedIdentity,
          currentIdentity: () => managedSelfContextIdentityRef.current,
          request: () => client.listOrganizationMemberships(),
        })
      : Promise.resolve(null);
    const [nextAccessContext, nextWorkspaces, nextManagedSelfContext] = await Promise.all([
      client.getAccessContext(),
      client.listWorkspaces(),
      selfContextPromise,
    ]);
    if (!ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal)) {
      return false;
    }
    if (acceptedManagedIdentity && nextManagedSelfContext === null) return false;
    if (
      nextManagedSelfContext &&
      nextAccessContext.subjectId !== nextManagedSelfContext.identity.subjectId
    ) {
      throw new Error("managed self context did not match the authenticated subject");
    }
    if (
      accessPrincipalIdRef.current !== null &&
      accessPrincipalIdRef.current !== nextAccessContext.subjectId
    ) {
      invalidatePrincipalWorkspaceState();
      acceptedPrincipal = principalTransitionIdentity.current;
      managedSelfContextIdentityRef.current = acceptedManagedIdentity;
    }
    if (!ownsPrincipalTransition(principalTransitionIdentity.current, acceptedPrincipal)) {
      return false;
    }
    accessPrincipalIdRef.current = nextAccessContext.subjectId;
    claimHumanInputDraftOwner(nextAccessContext.subjectId);
    setAccessContext(nextAccessContext);
    setWorkspaces(nextWorkspaces);
    setManagedSelfContext(nextManagedSelfContext);
    return true;
  }
  const contextRefreshPrincipalAccess = useLatestCallback(refreshPrincipalAccess);
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
      await slackLink.prepare(
        workspaceId,
        async (token) =>
          await client.prepareSlackUserLinkAccess(workspaceId, {
            linkToken: token,
          }),
      ),
    [client, slackLink],
  );
  const clearSlackLinkContinuation = useCallback(() => {
    slackLink.clear();
    setSlackLinkContinuationWorkspaceId(null);
  }, [slackLink]);

  const appContext = useMemo<AppContextValue | null>(() => {
    return clientConfig && accessContext
      ? ({
          client,
          clientConfig: {
            ...clientConfig,
            voiceInput:
              workspaceVoiceInput ??
              (clientConfig.voiceInput
                ? { ...clientConfig.voiceInput, available: false, providers: [] }
                : undefined),
          },
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
          workspaceMcpCatalogLoadedSuccessfully,
          workspaceCapabilityCatalog,
          currentResources,
          repositoryValidationError,
          workspaceStateOwnerId,
          prepareWorkspaceTransition,
          captureWorkspaceInvocation,
          ownsWorkspaceInvocation,
          addManualRepository: contextAddManualRepository,
          forgetAccessKey: contextForgetAccessKey,
          handleManagedSignOut: contextHandleManagedSignOut,
          revalidatePrincipalAccess,
          refreshPrincipalAccess: contextRefreshPrincipalAccess,
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
    workspaceVoiceInput,
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
    repositoryValidationError,
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
    contextRefreshPrincipalAccess,
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
    workspaceMcpCatalogLoadedSuccessfully,
    workspaceCapabilityCatalog,
    workspaceStateOwnerId,
    workspaces,
  ]);

  return {
    appContext,
    client,
    clientConfig,
    configError,
    retryClientConfig: () => {
      // A calm waiting state stays up while the retry runs.
      setConfigError((current) => (current?.recovering ? current : null));
      setConfigRequestVersion((version) => version + 1);
    },
    authSession,
    accessContext,
    accessError,
    accessLoading,
    accessKeyVersion,
    retryAccess: () => setAccessKeyVersion((version) => version + 1),
    keyAuthRequired,
    hasAccessKey,
    accessKeyDraft,
    setAccessKeyDraft,
    saveAccessKey,
    managedAuthRequired,
    managedEmailVerificationRequired,
    managedNewSignupsEnabled,
    managedSocialProviders,
    browserAccountsConfigured,
    browserAccountsEnabled,
    handleManagedAuth,
    handleManagedSessionSetSignup,
    handleManagedSocialAuth,
    handleManagedSignOut: contextHandleManagedSignOut,
    handleBrowserActorTransition: contextHandleBrowserActorTransition,
    completeOrganizationOnboarding,
    revalidatePrincipalAccess,
    defaultWorkspaceId,
    slackLinkContinuationWorkspaceId,
    routedWorkspace,
    creditRequired,
    setCreditRequired,
    mutationBusy: busy || repoBusy || githubAppBusy || pendingCreateAttempt.current !== null,
  };
}

/** Posts the GitHub App manifest; an embedded app opens it beside the host page. */
function submitGitHubManifest(
  actionUrl: string,
  manifest: Record<string, unknown>,
  newTab: boolean,
): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = actionUrl;
  if (newTab) form.target = "_blank";
  form.style.display = "none";
  form.acceptCharset = "utf-8";

  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = JSON.stringify(manifest);

  form.append(input);
  document.body.append(form);
  form.submit();
  // A same-tab post leaves the page anyway; a new-tab post must not leave the
  // manifest behind in the host page.
  if (newTab) form.remove();
}
