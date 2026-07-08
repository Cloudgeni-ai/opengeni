// Root providers: client config bootstrap, auth (deployment key / configured
// token / managed session), workspace access, and the cross-route console
// state (model choice, repo selection, tool toggles). Everything below the
// workspace shell consumes this through `useAppContext`.
import type { OpenGeniClient } from "@opengeni/sdk";
import type { SessionEventsConnectionState } from "@opengeni/react";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { CheckIcon, Loader2Icon, LockIcon, RefreshCwIcon, UserIcon } from "lucide-react";
import {
  createContext,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Toaster, toast } from "sonner";

import {
  clearStoredAccessKey,
  createOpenGeniClient,
  fetchAuthSession,
  fetchClientConfig,
  getStoredAccessKey,
  sendVerificationEmail,
  setStoredAccessKey,
  signInEmail,
  signOutManaged,
  signUpEmail,
} from "@/api";
import { LoadingPanel, ProblemPanel } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sameSessionForContext } from "@/lib/session-context";
import {
  buildResources,
  buildTools,
  enabledWorkspaceCapabilityMcpServers,
  groupRepositories,
  initialReasoningEffort,
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
import type {
  AccessContext,
  AuthSession,
  ClientConfig,
  CreateWorkspaceRequest,
  GitHubRepository,
  ResourceRef,
  Session,
  TurnSubmission,
  UpdateWorkspaceSettingsRequest,
  Workspace,
} from "@/types";

export type AppContextValue = {
  client: OpenGeniClient;
  clientConfig: ClientConfig;
  authSession: AuthSession | null;
  accessContext: AccessContext;
  workspaces: Workspace[];
  accessKeyVersion: number;
  keyAuthRequired: boolean;
  model: string;
  setModel: Dispatch<SetStateAction<string>>;
  /**
   * The model chosen for a specific open session. Composer state (draft, mode)
   * is session-scoped, and so is the model: each session remembers its own pick
   * in-memory, falling back to the deployment default ({@link model}) until the
   * operator overrides it. The new-session surface uses the bare {@link model}
   * (no session id yet); the session route threads its id through these.
   */
  modelForSession: (sessionId: string) => string;
  setModelForSession: (sessionId: string, value: string) => void;
  reasoningEffort: IntelligenceEffort;
  setReasoningEffort: Dispatch<SetStateAction<IntelligenceEffort>>;
  inspectorOpen: boolean;
  setInspectorOpen: Dispatch<SetStateAction<boolean>>;
  session: Session | null;
  setSession: Dispatch<SetStateAction<Session | null>>;
  connectionState: SessionEventsConnectionState;
  setConnectionState: Dispatch<SetStateAction<SessionEventsConnectionState>>;
  manualRepos: RepoDraft[];
  setManualRepos: Dispatch<SetStateAction<RepoDraft[]>>;
  manualReposOpen: boolean;
  setManualReposOpen: Dispatch<SetStateAction<boolean>>;
  selectedRepoIds: Set<number>;
  setSelectedRepoIds: Dispatch<SetStateAction<Set<number>>>;
  selectedRepoRefs: Record<number, string>;
  setSelectedRepoRefs: Dispatch<SetStateAction<Record<number, string>>>;
  githubRepos: GitHubRepository[];
  githubStatus: { configured: boolean; missing: string[]; installUrl: string | null } | null;
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
  currentResources: ResourceRef[];
  addManualRepository: () => void;
  forgetAccessKey: () => void;
  handleManagedSignOut: () => Promise<void>;
  createWorkspace: (request: CreateWorkspaceRequest) => Promise<Workspace | null>;
  renameWorkspace: (workspaceId: string, name: string) => Promise<Workspace | null>;
  updateWorkspaceSettings: (workspaceId: string, settings: UpdateWorkspaceSettingsRequest) => Promise<Workspace | null>;
  updateSessionTitle: (workspaceId: string, sessionId: string, title: string) => Promise<Session | null>;
  deleteWorkspace: (workspaceId: string) => Promise<boolean>;
  refreshGitHub: (workspaceId: string, signal?: AbortSignal, options?: { sync?: boolean }) => Promise<void>;
  refreshWorkspaceMcpServers: (workspaceId: string, signal?: AbortSignal) => Promise<void>;
  startGitHubAppManifestFlow: (workspaceId: string) => Promise<void>;
  toggleGitHubRepository: (repo: GitHubRepository) => void;
  startSession: (
    workspaceId: string,
    submission: TurnSubmission,
    options?: { targetSandboxId?: string | null; workingDir?: string | null; omitWorkspaceResources?: boolean },
  ) => Promise<Session | null>;
  resetSessionView: () => void;
  resetWorkspaceIntegrations: () => void;
};

const AppContext = createContext<AppContextValue | null>(null);

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
  const [clientConfig, setClientConfig] = useState<ClientConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [authSession, setAuthSession] = useState<AuthSession | null | undefined>(undefined);
  const [accessContext, setAccessContext] = useState<AccessContext | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [model, setModel] = useState("gpt-5.5");
  // Per-session model overrides (session id → model). A session with no entry
  // inherits the deployment default `model`; selecting in its picker writes here
  // so each open session keeps its own choice independently.
  const [modelBySession, setModelBySession] = useState<Record<string, string>>({});
  const [reasoningEffort, setReasoningEffort] = useState<IntelligenceEffort>("low");
  // The dock is open by default on desktop, but on narrow viewports (<1024px)
  // the dock renders as a full-screen overlay — so it must start CLOSED there or
  // a phone opening a session would land with the overlay covering the
  // transcript. Only the initial default is viewport-aware; the user's later
  // toggles are never overridden.
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(() =>
    typeof window === "undefined" ? true : !window.matchMedia("(max-width: 1023px)").matches,
  );
  const [connectionState, setConnectionState] = useState<SessionEventsConnectionState>("idle");
  const [manualRepos, setManualRepos] = useState<RepoDraft[]>([]);
  const [manualReposOpen, setManualReposOpen] = useState(false);
  const [nextRepoId, setNextRepoId] = useState(1);
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<number>>(() => new Set());
  const [selectedRepoRefs, setSelectedRepoRefs] = useState<Record<number, string>>({});
  const [githubRepos, setGithubRepos] = useState<GitHubRepository[]>([]);
  const [githubStatus, setGithubStatus] = useState<{ configured: boolean; missing: string[]; installUrl: string | null } | null>(null);
  const [githubAppOpen, setGithubAppOpen] = useState(false);
  const [githubOrg, setGithubOrg] = useState("");
  const [workspaceMcpServers, setWorkspaceMcpServers] = useState<McpServerOption[]>([]);
  const [selectedCapabilityToolIds, setSelectedCapabilityToolIds] = useState<Set<string>>(() => new Set());
  // Seed "docs" as already-seen so Document Search is not auto-selected on first
  // load (it stays opt-in, as the old Docs toggle was). Every other tool server,
  // including the first-party "opengeni", is auto-selected when it first appears.
  const previousCapabilityToolIds = useRef<Set<string>>(new Set(["docs"]));
  const githubRefreshId = useRef(0);
  const mcpRefreshId = useRef(0);
  // Stable CREATE idempotency key for the in-flight session create. Generated
  // lazily and reused across retries (and across a double-click that re-enters
  // startSession before busy flips), so duplicate creates collapse to one
  // session server-side; cleared only once a create succeeds so the next real
  // submit gets a fresh, independent key. Distinct from the per-call
  // clientEventId (a fresh UUID every send).
  const pendingCreateKey = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [repoBusy, setRepoBusy] = useState(false);
  const [githubAppBusy, setGithubAppBusy] = useState(false);
  const [hasAccessKey, setHasAccessKey] = useState(() => getStoredAccessKey() !== null);
  const [accessKeyDraft, setAccessKeyDraft] = useState("");
  const [accessKeyVersion, setAccessKeyVersion] = useState(0);
  const keyAuthRequired = clientConfig?.auth.mode === "deploymentKey" || clientConfig?.auth.mode === "configuredToken";
  const managedAuthRequired = clientConfig?.auth.mode === "managedSession";
  const keyAuthReady = !keyAuthRequired || hasAccessKey;
  const managedAuthReady = !managedAuthRequired || Boolean(authSession);
  const authReady = keyAuthReady && managedAuthReady;
  const defaultWorkspaceId = accessContext?.defaultWorkspaceId ?? workspaces[0]?.id ?? accessContext?.workspaceGrants[0]?.workspaceId ?? null;
  const navigate = useNavigate();
  // Public routes render ahead of every auth/config gate: a user completing a
  // password reset is signed out by definition, so `/reset-password` must never
  // be intercepted by the sign-in panel or workspace-access loading.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isPublicAuthRoute = pathname === "/reset-password";
  // The @opengeni/sdk client behind every console API call and hook. Auth
  // headers are read per request; a new identity per key version makes the
  // hooks re-fetch and the event streams reconnect with the new credentials.
  const client = useMemo(() => createOpenGeniClient(), [accessKeyVersion]);
  const setSession = useCallback<Dispatch<SetStateAction<Session | null>>>((value) => {
    setSessionState((current) => {
      const next = typeof value === "function"
        ? (value as (previous: Session | null) => Session | null)(current)
        : value;
      return sameSessionForContext(current, next) ? current : next;
    });
  }, []);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    if (!clientConfig) {
      return;
    }
    if (clientConfig.auth.mode !== "managedSession") {
      setAuthSession(null);
      return;
    }
    let cancelled = false;
    setAuthSession(undefined);
    void fetchAuthSession()
      .then((nextSession) => {
        if (!cancelled) {
          setAuthSession(nextSession);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAuthSession(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [clientConfig]);

  useEffect(() => {
    if (!clientConfig || !authReady) {
      setAccessContext(null);
      setWorkspaces([]);
      setAccessLoading(false);
      setAccessError(null);
      return;
    }
    let cancelled = false;
    setAccessLoading(true);
    setAccessError(null);
    void Promise.all([client.getAccessContext(), client.listWorkspaces()])
      .then(([context, nextWorkspaces]) => {
        if (cancelled) {
          return;
        }
        setAccessContext(context);
        setWorkspaces(nextWorkspaces);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        toast.error("Failed to load workspace access", { description: String(error) });
        setAccessContext(null);
        setWorkspaces([]);
        setAccessError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setAccessLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [clientConfig, authReady, client]);

  const selectedInstalledRepositories = githubRepos.filter((repo) => selectedRepoIds.has(repo.id));
  const selectedInstallationId = selectedInstalledRepositories[0]?.installationId ?? null;
  const repositoryGroups = useMemo(() => groupRepositories(githubRepos), [githubRepos]);
  const toolMcpServers = useMemo(
    () => mergeMcpServerOptions(selectableMcpServers(clientConfig), workspaceMcpServers),
    [clientConfig, workspaceMcpServers],
  );
  const currentResources = useMemo(
    () => buildResources(manualRepos, githubRepos, selectedRepoIds, selectedRepoRefs),
    [manualRepos, githubRepos, selectedRepoIds, selectedRepoRefs],
  );

  useEffect(() => {
    if (!clientConfig) {
      return;
    }
    const availableIds = toolMcpServers.map((server) => server.id);
    setSelectedCapabilityToolIds((current) => selectedAvailableCapabilityToolIds(current, availableIds, previousCapabilityToolIds.current));
    previousCapabilityToolIds.current = new Set(availableIds);
  }, [clientConfig, toolMcpServers]);

  // Workspace create/rename keep the cached `workspaces` list and the access
  // context (the create grants the caller an owner grant) in sync.
  async function createWorkspace(request: CreateWorkspaceRequest): Promise<Workspace | null> {
    let created: Workspace;
    try {
      created = await client.createWorkspace(request);
    } catch (error) {
      toast.error("Failed to create workspace", { description: error instanceof Error ? error.message : String(error) });
      return null;
    }
    setWorkspaces((current) => upsertWorkspace(current, created));
    // Refresh grants so the new workspace's owner permissions apply at once;
    // the workspace itself is already usable if this refresh fails — surface a
    // soft warning so a stale permission set doesn't fail silently.
    await client.getAccessContext().then(setAccessContext).catch(() => {
      toast.warning("Permissions may be out of date", { description: "Reload if something looks off." });
    });
    return created;
  }

  async function renameWorkspace(workspaceId: string, name: string): Promise<Workspace | null> {
    try {
      const updated = await client.updateWorkspace(workspaceId, { name });
      setWorkspaces((current) => upsertWorkspace(current, updated));
      return updated;
    } catch (error) {
      toast.error("Failed to rename workspace", { description: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  // Settings PATCH deep-merges server-side; upsert the returned workspace so the
  // cached list (and any settings-derived UI, e.g. the Documents memory pane)
  // reflects the change without a reload.
  async function updateWorkspaceSettings(workspaceId: string, settings: UpdateWorkspaceSettingsRequest): Promise<Workspace | null> {
    try {
      const updated = await client.updateWorkspaceSettings(workspaceId, settings);
      setWorkspaces((current) => upsertWorkspace(current, updated));
      return updated;
    } catch (error) {
      toast.error("Failed to update workspace settings", { description: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  // Manual session rename: writes a permanent (source='user') title via the
  // PATCH route, then patches the open session in-place so the header reflects
  // it at once. The rail list (its own polled hook) and any cross-client view
  // pick the change up via the session.title_set SSE event / next poll.
  async function updateSessionTitle(workspaceId: string, sessionId: string, title: string): Promise<Session | null> {
    try {
      const updated = await client.updateSession(workspaceId, sessionId, { title });
      setSession((current) => (current && current.id === updated.id ? { ...current, title: updated.title, titleSource: updated.titleSource } : current));
      return updated;
    } catch (error) {
      toast.error("Failed to rename session", { description: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  // Delete drops the workspace from the cached list and refreshes grants (the
  // owner grant for the deleted workspace is gone). The caller navigates away.
  async function deleteWorkspace(workspaceId: string): Promise<boolean> {
    try {
      await client.deleteWorkspace(workspaceId);
    } catch (error) {
      toast.error("Failed to delete workspace", { description: error instanceof Error ? error.message : String(error) });
      return false;
    }
    setWorkspaces((current) => current.filter((workspace) => workspace.id !== workspaceId));
    await client.getAccessContext().then(setAccessContext).catch(() => {
      toast.warning("Permissions may be out of date", { description: "Reload if something looks off." });
    });
    return true;
  }

  async function refreshGitHub(workspaceId: string, signal?: AbortSignal, options?: { sync?: boolean }) {
    const refreshId = githubRefreshId.current + 1;
    githubRefreshId.current = refreshId;
    setRepoBusy(true);
    try {
      const status = await client.getGitHubApp(workspaceId);
      if (signal?.aborted || githubRefreshId.current !== refreshId) {
        return;
      }
      setGithubStatus({ configured: status.configured, missing: status.missing, installUrl: status.installUrl });
      setGithubAppOpen(!status.configured);
      if (status.configured) {
        // Explicit refreshes re-sync from GitHub (POST /github/repositories/sync)
        // so installations changed after connect show up; passive loads read
        // OpenGeni's cached rows.
        const { repositories } = options?.sync
          ? await client.syncGitHubRepositories(workspaceId)
          : await client.listGitHubRepositories(workspaceId);
        if (signal?.aborted || githubRefreshId.current !== refreshId) {
          return;
        }
        setGithubRepos(repositories);
      } else {
        setGithubRepos([]);
      }
    } catch (error) {
      if (isAbortError(error) || signal?.aborted || githubRefreshId.current !== refreshId) {
        return;
      }
      setGithubStatus({ configured: false, missing: [], installUrl: null });
      setGithubRepos([]);
      toast.error("GitHub status unavailable", { description: String(error) });
    } finally {
      if (githubRefreshId.current === refreshId) {
        setRepoBusy(false);
      }
    }
  }

  async function refreshWorkspaceMcpServers(workspaceId: string, signal?: AbortSignal) {
    const refreshId = mcpRefreshId.current + 1;
    mcpRefreshId.current = refreshId;
    const catalog = await client.listCapabilities(workspaceId);
    if (signal?.aborted || mcpRefreshId.current !== refreshId) {
      return;
    }
    setWorkspaceMcpServers(enabledWorkspaceCapabilityMcpServers(catalog.items));
  }

  async function startSession(
    workspaceId: string,
    submission: TurnSubmission,
    options?: { targetSandboxId?: string | null; workingDir?: string | null; omitWorkspaceResources?: boolean },
  ): Promise<Session | null> {
    setBusy(true);
    // Reuse the in-flight key if one survives a prior failed/double-fired
    // attempt; otherwise mint a fresh stable key for this logical create.
    const idempotencyKey = pendingCreateKey.current ?? crypto.randomUUID();
    pendingCreateKey.current = idempotencyKey;
    try {
      const selectedTools = buildTools(submission.tools, [...selectedCapabilityToolIds]);
      const created = await client.createSession(workspaceId, {
        initialMessage: submission.text,
        // Workspace repo selection is excluded when the create targets a
        // connected machine (D3: the machine uses its own checkout & git auth);
        // uploaded file attachments (submission.resources) still flow through.
        resources: [...(options?.omitWorkspaceResources ? [] : currentResources), ...(submission.resources ?? [])],
        tools: selectedTools,
        model: submission.model ?? model,
        reasoningEffort: submission.reasoningEffort ?? reasoningEffort,
        clientEventId: crypto.randomUUID(),
        idempotencyKey,
        ...(submission.sandboxBackend ? { sandboxBackend: submission.sandboxBackend } : {}),
        ...(submission.environmentId ? { environmentId: submission.environmentId } : {}),
        ...(submission.goal ? { goal: submission.goal } : {}),
        ...(submission.firstPartyMcpPermissions ? { firstPartyMcpPermissions: submission.firstPartyMcpPermissions } : {}),
        // Seed the active-sandbox pointer at create (race-free) when a machine was
        // picked. The contract accepts `targetSandboxId`; the SDK's request type
        // doesn't yet surface it, so cast the field through.
        ...(options?.targetSandboxId
          ? ({ targetSandboxId: options.targetSandboxId } as { targetSandboxId: string })
          : {}),
        // The targeted machine's per-session working directory — a top-level create
        // field (only valid alongside targetSandboxId; the backend 422s it solo).
        ...(options?.workingDir ? { workingDir: options.workingDir } : {}),
      });
      // Success: release the key so the next distinct submit is independent.
      pendingCreateKey.current = null;
      setSession(created);
      setConnectionState("idle");
      return created;
    } catch (error) {
      // Keep the key on failure so a manual retry reuses it and dedups against
      // a create that may have actually landed server-side.
      toast.error("Failed to start session", { description: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function startGitHubAppManifestFlow(workspaceId: string) {
    setGithubAppBusy(true);
    try {
      const result = await client.createGitHubAppManifest(workspaceId, {
        ...(githubOrg.trim() ? { organization: githubOrg.trim() } : {}),
        public: false,
        includeCiPermissions: true,
      });
      submitGitHubManifest(result.actionUrl, result.manifest);
    } catch (error) {
      toast.error("GitHub App setup failed", { description: error instanceof Error ? error.message : String(error) });
      setGithubAppBusy(false);
    }
  }

  function toggleGitHubRepository(repo: GitHubRepository) {
    if (selectedInstallationId !== null && selectedInstallationId !== repo.installationId && !selectedRepoIds.has(repo.id)) {
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
    setSelectedRepoRefs((current) => ({ ...current, [repo.id]: current[repo.id] ?? repo.defaultBranch }));
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
    setStoredAccessKey(key);
    setHasAccessKey(true);
    setAccessKeyDraft("");
    setAccessError(null);
    setAccessKeyVersion((version) => version + 1);
  }

  function forgetAccessKey() {
    clearStoredAccessKey();
    setHasAccessKey(false);
    setSession(null);
    setAccessContext(null);
    setWorkspaces([]);
    setAccessError(null);
    setAccessKeyVersion((version) => version + 1);
  }

  async function handleManagedAuth(mode: "signin" | "signup", input: { name: string; email: string; password: string }) {
    if (mode === "signup") {
      await signUpEmail(input);
    } else {
      await signInEmail({ email: input.email, password: input.password, rememberMe: true });
    }
    const nextSession = await fetchAuthSession();
    setAuthSession(nextSession);
    setAccessKeyVersion((version) => version + 1);
    if (!nextSession && mode === "signup") {
      toast.success("Check your email to verify the account");
    }
  }

  async function handleManagedSignOut() {
    await signOutManaged();
    setAuthSession(null);
    setAccessContext(null);
    setWorkspaces([]);
    setSession(null);
    setAccessError(null);
    setAccessKeyVersion((version) => version + 1);
    await navigate({ to: "/", replace: true });
  }

  function resetSessionView() {
    setSession(null);
    setConnectionState("idle");
  }

  // Session-scoped model: read the session's override or fall back to the
  // deployment default; writing records it without disturbing other sessions
  // (or the new-session surface, which reads the bare `model`).
  function modelForSession(sessionId: string): string {
    return modelBySession[sessionId] ?? model;
  }
  function setModelForSession(sessionId: string, value: string): void {
    setModelBySession((current) => ({ ...current, [sessionId]: value }));
  }

  function resetWorkspaceIntegrations() {
    setGithubStatus(null);
    setGithubRepos([]);
    setWorkspaceMcpServers([]);
  }

  const appContext = clientConfig && accessContext ? {
    client,
    clientConfig,
    authSession: authSession ?? null,
    accessContext,
    workspaces,
    accessKeyVersion,
    keyAuthRequired: keyAuthRequired === true,
    model,
    setModel,
    modelForSession,
    setModelForSession,
    reasoningEffort,
    setReasoningEffort,
    inspectorOpen,
    setInspectorOpen,
    session,
    setSession,
    connectionState,
    setConnectionState,
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
    currentResources,
    addManualRepository,
    forgetAccessKey,
    handleManagedSignOut,
    createWorkspace,
    renameWorkspace,
    updateWorkspaceSettings,
    updateSessionTitle,
    deleteWorkspace,
    refreshGitHub,
    refreshWorkspaceMcpServers,
    startGitHubAppManifestFlow,
    toggleGitHubRepository,
    startSession,
    resetSessionView,
    resetWorkspaceIntegrations,
  } satisfies AppContextValue : null;

  return (
    <main className="flex h-dvh min-h-screen flex-col overflow-x-hidden bg-bg text-fg">
      <Toaster richColors theme="dark" />
      {isPublicAuthRoute ? (
        // Self-contained public page (e.g. /reset-password): rendered before the
        // config/auth gates and outside AppContext, so it works for a signed-out
        // visitor even while client config is still loading.
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
        <ManagedAuthPanel onSubmit={handleManagedAuth} />
      ) : accessError && !accessLoading ? (
        <ProblemPanel
          title="Workspace access unavailable"
          description={accessError}
          action={(
            <Button type="button" variant="secondary" onClick={() => setAccessKeyVersion((version) => version + 1)}>
              Retry
            </Button>
          )}
        />
      ) : accessLoading || !appContext ? (
        <LoadingPanel label="Loading workspace access" />
      ) : !defaultWorkspaceId ? (
        <ProblemPanel title="No workspace access" description="You don't have access to any workspace yet." />
      ) : (
        <AppContext.Provider value={appContext}>
          <Outlet />
          {import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-right" /> : null}
        </AppContext.Provider>
      )}
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
              Enter the {props.authMode === "configuredToken" ? "configured bearer token" : "deployment key"} for this OpenGeni instance.
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
        <Button type="submit" className="mt-4 w-full" disabled={props.accessKeyDraft.trim().length === 0}>
          <CheckIcon className="size-4" />
          Continue
        </Button>
      </form>
    </section>
  );
}

function ManagedAuthPanel(props: {
  onSubmit: (mode: "signin" | "signup", input: { name: string; email: string; password: string }) => Promise<void>;
}) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);

  async function submit() {
    if (!email.trim() || password.length < 8 || (mode === "signup" && !name.trim())) {
      toast.error("Enter valid account details");
      return;
    }
    setBusy(true);
    try {
      await props.onSubmit(mode, { name: name.trim() || email.trim(), email: email.trim(), password });
    } catch (error) {
      toast.error(mode === "signup" ? "Sign up failed" : "Sign in failed", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      toast.error("Enter your email");
      return;
    }
    setResendBusy(true);
    try {
      await sendVerificationEmail({ email: normalizedEmail });
      toast.success("Verification email sent");
    } catch (error) {
      toast.error("Failed to send verification email", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setResendBusy(false);
    }
  }

  return (
    <section className="flex flex-1 items-center justify-center px-4">
      <form
        className="w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <UserIcon className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold">{mode === "signup" ? "Create account" : "Sign in"}</h1>
            <p className="text-sm text-fg-subtle">Email and password access for the managed console.</p>
          </div>
        </div>
        <div className="mb-4 grid grid-cols-2 rounded-md border border-border bg-bg p-1">
          <Button type="button" size="sm" variant={mode === "signin" ? "secondary" : "ghost"} onClick={() => setMode("signin")}>Sign in</Button>
          <Button type="button" size="sm" variant={mode === "signup" ? "secondary" : "ghost"} onClick={() => setMode("signup")}>Sign up</Button>
        </div>
        {mode === "signup" ? (
          <div className="mb-3">
            <Label htmlFor="managed-auth-name">Name</Label>
            <Input id="managed-auth-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" className="mt-2" />
          </div>
        ) : null}
        <div className="mb-3">
          <Label htmlFor="managed-auth-email">Email</Label>
          <Input id="managed-auth-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" className="mt-2" autoFocus />
        </div>
        <div>
          <Label htmlFor="managed-auth-password">Password</Label>
          <Input id="managed-auth-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "signin" ? "current-password" : "new-password"} className="mt-2" />
        </div>
        <Button type="submit" className="mt-4 w-full" disabled={busy}>
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : <CheckIcon className="size-4" />}
          {mode === "signup" ? "Create account" : "Sign in"}
        </Button>
        <Button type="button" variant="ghost" className="mt-2 w-full" disabled={resendBusy || busy} onClick={() => void resendVerification()}>
          {resendBusy ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />}
          Resend verification email
        </Button>
      </form>
    </section>
  );
}
