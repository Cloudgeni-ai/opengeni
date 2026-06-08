import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  BotIcon,
  CalendarClockIcon,
  CheckIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDashedIcon,
  CopyIcon,
  DownloadIcon,
  FileJsonIcon,
  FilesIcon,
  FileSearchIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  GlobeIcon,
  ImageIcon,
  Loader2Icon,
  LockIcon,
  PackageIcon,
  PanelRightIcon,
  PauseIcon,
  PlugIcon,
  PlusIcon,
  PlayIcon,
  RefreshCwIcon,
  SearchIcon,
  SparkleIcon,
  SquareIcon,
  TerminalIcon,
  Trash2Icon,
  UserIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";

import { Composer } from "@/components/Composer";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  addDocumentToBase,
  createCapability,
  createSession,
  createDocumentBase,
  createScheduledTask,
  deleteScheduledTask,
  disableCapability,
  discoverMcpRegistryCapabilities,
  enableCapability,
  fetchCapabilities,
  fetchClientConfig,
  fetchDocumentBases,
  fetchDocuments,
  fetchEvents,
  fetchFileAsset,
  fetchFileDownloadUrl,
  fetchGitHubRepositories,
  fetchGitHubStatus,
  fetchScheduledTaskRuns,
  fetchScheduledTasks,
  getStoredAccessKey,
  reindexDocument,
  fetchSession,
  pauseScheduledTask,
  resumeScheduledTask,
  sendApproval,
  sendInterrupt,
  sendUserMessage,
  searchDocumentBase,
  setStoredAccessKey,
  startGitHubManifest,
  streamSessionEvents,
  triggerScheduledTask,
  updateScheduledTask,
  uploadFileAsset,
  clearStoredAccessKey,
} from "./api";
import type {
  CapabilityCatalogItem,
  CapabilityKind,
  ClientConfig,
  CreateCapabilityInput,
  DocumentBase,
  DocumentSearchResult,
  FileAsset,
  GitHubRepository,
  IndexedDocument,
  ReasoningEffort,
  ResourceRef,
  ScheduledTask,
  ScheduledTaskAgentConfig,
  ScheduledTaskRun,
  ScheduledTaskScheduleSpec,
  Session,
  SessionEvent,
  SessionStatus,
  ToolRef,
  TurnSubmission,
} from "./types";
import { cn } from "@/lib/utils";
import { Streamdown, type StreamdownComponents } from "./vendor/streamdown-runtime.js";

const examples = [
  "Inspect the repository and summarize the infrastructure layout.",
  "Run Terraform and Checkov checks, then propose the smallest safe fix.",
  "Create a focused GitHub PR for the failing policy check.",
] as const;

type RepoDraft = { id: number; url: string; ref: string };
type IntelligenceEffort = Extract<ReasoningEffort, "low" | "medium" | "high" | "xhigh">;
type ConnectionState = "connecting" | "live" | "closed" | "error";
const uiReasoningEffortOrder: IntelligenceEffort[] = ["low", "medium", "high", "xhigh"];

type ConversationTraceKind = "reasoning" | "tool" | "sandbox" | "approval" | "error" | "status";
type ConversationTraceStatus = "running" | "complete" | "failed" | "waiting";

type ConversationTraceItem = {
  id: string;
  key: string;
  kind: ConversationTraceKind;
  status: ConversationTraceStatus;
  title: string;
  detail?: string;
  output?: string;
  occurredAt: string;
};

type ConversationUserTurn = {
  kind: "user";
  id: string;
  text: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  occurredAt: string;
};

type ConversationAssistantTurn = {
  kind: "assistant";
  id: string;
  turnId: string | null;
  text: string;
  status: "pending" | "running" | "complete" | "requires_action" | "failed" | "cancelled";
  error?: string;
  occurredAt: string;
};

type ConversationActivityTurn = {
  kind: "activity";
  id: string;
  turnId: string | null;
  status: "running" | "complete" | "requires_action" | "failed" | "cancelled";
  trace: ConversationTraceItem[];
  occurredAt: string;
};

type ConversationTurn = ConversationUserTurn | ConversationAssistantTurn | ConversationActivityTurn;

export function App() {
  const [sessionId, setSessionId] = useState(() => sessionIdFromPath());
  const [activeView, setActiveView] = useState<"agent" | "documents" | "capabilities">("agent");
  const [session, setSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [clientConfig, setClientConfig] = useState<ClientConfig | null>(null);
  const [model, setModel] = useState("gpt-5.5");
  const [reasoningEffort, setReasoningEffort] = useState<IntelligenceEffort>("high");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [connectionState, setConnectionState] = useState<ConnectionState>("closed");
  const [manualRepos, setManualRepos] = useState<RepoDraft[]>([]);
  const [manualReposOpen, setManualReposOpen] = useState(false);
  const [nextRepoId, setNextRepoId] = useState(1);
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<number>>(() => new Set());
  const [selectedRepoRefs, setSelectedRepoRefs] = useState<Record<number, string>>({});
  const [githubRepos, setGithubRepos] = useState<GitHubRepository[]>([]);
  const [githubStatus, setGithubStatus] = useState<{ configured: boolean; missing: string[]; installUrl: string | null } | null>(null);
  const [githubAppOpen, setGithubAppOpen] = useState(false);
  const [githubOrg, setGithubOrg] = useState("");
  const [openGeniToolEnabled, setOpenGeniToolEnabled] = useState(true);
  const [documentSearchEnabled, setDocumentSearchEnabled] = useState(false);
  const [selectedCapabilityToolIds, setSelectedCapabilityToolIds] = useState<Set<string>>(() => new Set());
  const previousCapabilityToolIds = useRef<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [repoBusy, setRepoBusy] = useState(false);
  const [githubAppBusy, setGithubAppBusy] = useState(false);
  const [hasAccessKey, setHasAccessKey] = useState(() => getStoredAccessKey() !== null);
  const [accessKeyDraft, setAccessKeyDraft] = useState("");
  const [accessKeyVersion, setAccessKeyVersion] = useState(0);
  const lastSequence = useMemo(() => events.reduce((max, event) => Math.max(max, event.sequence), 0), [events]);
  const authRequired = clientConfig?.auth.required === true;
  const authReady = !authRequired || hasAccessKey;

  useEffect(() => {
    void fetchClientConfig()
      .then((config) => {
        setClientConfig(config);
        setModel(config.defaultModel);
        if (isUiReasoningEffort(config.defaultReasoningEffort)) {
          setReasoningEffort(config.defaultReasoningEffort);
        }
      })
      .catch((error) => toast.error("Failed to load client config", { description: String(error) }));
  }, []);

  useEffect(() => {
    if (!clientConfig || !authReady) {
      return;
    }
    void refreshGitHub();
  }, [clientConfig, authReady, accessKeyVersion]);

  useEffect(() => {
    if (!authReady) {
      return;
    }
    if (!sessionId) {
      setSession(null);
      setEvents([]);
      setConnectionState("closed");
      return;
    }
    void fetchSession(sessionId).then(setSession).catch((error) => toast.error("Failed to load session", { description: String(error) }));
    void fetchEvents(sessionId).then(setEvents).catch((error) => toast.error("Failed to load events", { description: String(error) }));
  }, [sessionId, authReady, accessKeyVersion]);

  useSessionStream(authReady ? sessionId : null, lastSequence, accessKeyVersion, (incoming) => {
    setEvents((current) => mergeEvents(current, incoming));
    setSession((current) => current ? applySessionStatusEvents(current, incoming) : current);
  }, setConnectionState);

  const selectedInstalledRepositories = githubRepos.filter((repo) => selectedRepoIds.has(repo.id));
  const selectedInstallationId = selectedInstalledRepositories[0]?.installationId ?? null;
  const repositoryGroups = useMemo(() => groupRepositories(githubRepos), [githubRepos]);
  const conversation = useMemo(() => session ? projectConversation(session, events) : [], [session, events]);
  const approvals = events.flatMap((event) => event.type === "session.requiresAction" ? approvalItems(event.payload) : []);
  const canSendFollowUp = session?.status === "idle";
  const sessionRunning = session?.status === "running" || session?.status === "queued";
  const customMcpServers = useMemo(() => enabledCustomMcpServers(clientConfig), [clientConfig]);

  useEffect(() => {
    if (!clientConfig) {
      return;
    }
    const availableIds = customMcpServers.map((server) => server.id);
    setSelectedCapabilityToolIds((current) => selectedAvailableCapabilityToolIds(current, availableIds, previousCapabilityToolIds.current));
    previousCapabilityToolIds.current = new Set(availableIds);
  }, [clientConfig, customMcpServers]);

  async function refreshGitHub() {
    setRepoBusy(true);
    try {
      const status = await fetchGitHubStatus();
      setGithubStatus(status);
      setGithubAppOpen(!status.configured);
      if (status.configured) {
        setGithubRepos(await fetchGitHubRepositories());
      }
    } catch (error) {
      setGithubStatus({ configured: false, missing: [], installUrl: null });
      toast.error("GitHub status unavailable", { description: String(error) });
    } finally {
      setRepoBusy(false);
    }
  }

  async function refreshClientConfig() {
    const config = await fetchClientConfig();
    setClientConfig(config);
    setModel((current) => config.allowedModels.includes(current) ? current : config.defaultModel);
    if (isUiReasoningEffort(config.defaultReasoningEffort)) {
      setReasoningEffort((current) => config.allowedReasoningEfforts.includes(current) ? current : config.defaultReasoningEffort as IntelligenceEffort);
    }
  }

  async function submitInitial(submission: TurnSubmission) {
    setBusy(true);
    try {
      const selectedResources = buildResources(manualRepos, githubRepos, selectedRepoIds, selectedRepoRefs);
      const selectedTools = buildTools(submission.tools, documentSearchEnabled, openGeniToolEnabled, [...selectedCapabilityToolIds]);
      const created = await createSession({
        initialMessage: submission.text,
        resources: [...selectedResources, ...(submission.resources ?? [])],
        tools: selectedTools,
        model,
        reasoningEffort,
      });
      rememberSession(created);
      setSession(created);
      setSessionId(created.id);
      window.history.pushState({}, "", `/sessions/${created.id}`);
    } catch (error) {
      toast.error("Failed to start session", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  function selectSession(id: string) {
    setActiveView("agent");
    setSessionId(id);
    window.history.pushState({}, "", `/sessions/${id}`);
  }

  function goHome() {
    setActiveView("agent");
    setSessionId(null);
    window.history.pushState({}, "", "/");
  }

  async function submitFollowUp(submission: TurnSubmission) {
    if (!session || !submission.text.trim()) {
      return;
    }
    setBusy(true);
    try {
      await sendUserMessage(session.id, {
        ...submission,
        text: submission.text.trim(),
        tools: buildTools(submission.tools, documentSearchEnabled, openGeniToolEnabled, [...selectedCapabilityToolIds]),
        model,
        reasoningEffort,
      });
      setSession(await fetchSession(session.id));
    } catch (error) {
      toast.error("Failed to send follow-up", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function interruptSession() {
    if (!session || !sessionRunning) {
      return;
    }
    setBusy(true);
    try {
      await sendInterrupt(session.id, "user requested cancellation");
      setSession(await fetchSession(session.id));
    } catch (error) {
      toast.error("Failed to interrupt session", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function startGitHubAppManifestFlow() {
    setGithubAppBusy(true);
    try {
      const result = await startGitHubManifest(githubOrg.trim() || undefined);
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
    setAccessKeyVersion((version) => version + 1);
  }

  function forgetAccessKey() {
    clearStoredAccessKey();
    setHasAccessKey(false);
    setSession(null);
    setEvents([]);
    setAccessKeyVersion((version) => version + 1);
  }

  return (
    <main className="flex h-dvh min-h-screen flex-col overflow-x-hidden bg-[color:var(--color-bg)] text-[color:var(--color-fg)]">
      <Toaster richColors theme="dark" />
      <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-[color:var(--color-border)] bg-[color:var(--color-bg)]/75 px-4 backdrop-blur sm:px-6">
        <button
          type="button"
          onClick={goHome}
          className="flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 text-[15px] font-medium text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface-2)]"
        >
          <span className="flex size-6 items-center justify-center rounded-md bg-[color:var(--color-brand-strong)]/20 text-[color:var(--color-brand)]">
            <SparkleIcon className="size-3.5" />
          </span>
          <span>OpenGeni Agent</span>
        </button>

        <nav className="flex items-center gap-1 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-1">
          <Button
            type="button"
            variant={activeView === "agent" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setActiveView("agent")}
            className="h-8 px-2.5 text-xs"
          >
            <BotIcon className="size-3.5" />
            <span className="hidden sm:inline">Agent</span>
          </Button>
          <Button
            type="button"
            variant={activeView === "documents" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setActiveView("documents")}
            className="h-8 px-2.5 text-xs"
          >
            <FileSearchIcon className="size-3.5" />
            <span className="hidden sm:inline">Documents</span>
          </Button>
          <Button
            type="button"
            variant={activeView === "capabilities" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setActiveView("capabilities")}
            className="h-8 px-2.5 text-xs"
          >
            <PlugIcon className="size-3.5" />
            <span className="hidden sm:inline">Capabilities</span>
          </Button>
        </nav>

        {session && activeView === "agent" ? (
          <div className="flex min-w-0 items-center gap-2">
            <Button type="button" variant="ghost" size="icon-sm" onClick={goHome} aria-label="Back to sessions">
              <ArrowLeftIcon className="size-4" />
            </Button>
            <div className="hidden min-w-0 sm:block">
              <div className="truncate text-sm font-medium">{session.initialMessage}</div>
              <div className="truncate text-xs text-[color:var(--color-fg-subtle)]">
                {session.model} · {String(session.metadata.reasoningEffort ?? "high")} · {session.sandboxBackend}
              </div>
            </div>
          </div>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {authRequired ? (
            <Button type="button" variant="ghost" size="icon-sm" onClick={forgetAccessKey} aria-label="Clear access key">
              <LockIcon className="size-4" />
            </Button>
          ) : null}
          {session && activeView === "agent" ? <ConnectionPill state={connectionState} /> : null}
          {session && activeView === "agent" ? <StatusBadge status={session.status} /> : null}
          {session && activeView === "agent" ? (
            <Button
              type="button"
              variant={inspectorOpen ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => setInspectorOpen((open) => !open)}
              aria-label="Toggle debug inspector"
            >
              <PanelRightIcon className="size-4" />
            </Button>
          ) : null}
        </div>
      </header>

      {authRequired && !hasAccessKey ? (
        <section className="flex flex-1 items-center justify-center px-4">
          <form
            className="w-full max-w-sm rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-5 shadow-sm"
            onSubmit={(event) => {
              event.preventDefault();
              saveAccessKey();
            }}
          >
            <div className="mb-4 flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-md bg-[color:var(--color-brand-strong)]/20 text-[color:var(--color-brand)]">
                <LockIcon className="size-4" />
              </span>
              <div>
                <h1 className="text-base font-semibold">Access key required</h1>
                <p className="text-sm text-[color:var(--color-fg-subtle)]">Enter the deployment key for this OpenGeni instance.</p>
              </div>
            </div>
            <Label htmlFor="access-key">Access key</Label>
            <Input
              id="access-key"
              type="password"
              value={accessKeyDraft}
              onChange={(event) => setAccessKeyDraft(event.target.value)}
              autoComplete="current-password"
              className="mt-2"
              autoFocus
            />
            <Button type="submit" className="mt-4 w-full">
              <CheckIcon className="size-4" />
              Continue
            </Button>
          </form>
        </section>
      ) : (
        <>

      {activeView === "capabilities" ? (
        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8">
          <CapabilitiesWorkspace onRuntimeChanged={() => void refreshClientConfig()} />
        </div>
      ) : activeView === "documents" ? (
        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8">
          <DocumentsWorkspace fileUploadsEnabled={clientConfig?.fileUploads.enabled === true} />
        </div>
      ) : !session ? (
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pt-10 pb-16 sm:px-6 sm:pt-16">
          <section className="flex flex-col items-center gap-2 text-center">
            <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
              What should the agent do?
            </h1>
            <p className="max-w-md text-sm text-[color:var(--color-fg-muted)]">
              Start a durable sandbox session with live streams, approvals, interrupts, and follow-ups.
            </p>
          </section>

          <div className="mt-8">
            <Composer
              autoFocus
              pending={busy}
              fileUploadsEnabled={clientConfig?.fileUploads.enabled === true}
              placeholder="Describe a task for the agent..."
              submitLabel={busy ? "Starting" : "Send"}
              examples={examples}
              controlsStart={
                <div className="flex min-w-0 items-center gap-1.5">
                  <ModelPicker
                    config={clientConfig}
                    model={model}
                    effort={reasoningEffort}
                    disabled={busy}
                    onModelChange={setModel}
                    onEffortChange={setReasoningEffort}
                  />
                  <RepositoryContextPicker
                    configured={githubStatus?.configured === true}
                    installUrl={githubStatus?.installUrl ?? null}
                    repositories={githubRepos}
                    groups={repositoryGroups}
                    selectedRepoIds={selectedRepoIds}
                    selectedRepoRefs={selectedRepoRefs}
                    selectedInstallationId={selectedInstallationId}
                    manualRepos={manualRepos}
                    manualOpen={manualReposOpen}
                    githubAppOpen={githubAppOpen}
                    org={githubOrg}
                    pending={busy}
                    repoBusy={repoBusy}
                    githubAppBusy={githubAppBusy}
                    onRefresh={refreshGitHub}
                    onToggleRepo={toggleGitHubRepository}
                    onRefChange={(repoId, ref) => setSelectedRepoRefs((current) => ({ ...current, [repoId]: ref }))}
                    onManualOpenChange={setManualReposOpen}
                    onManualAdd={addManualRepository}
                    onManualUpdate={(id, patch) => setManualRepos((current) => current.map((repo) => repo.id === id ? { ...repo, ...patch } : repo))}
                    onManualRemove={(id) => setManualRepos((current) => current.filter((repo) => repo.id !== id))}
                    onGitHubAppOpenChange={setGithubAppOpen}
                    onOrgChange={setGithubOrg}
                    onStartGitHubApp={startGitHubAppManifestFlow}
                  />
                  <DocumentSearchToolToggle
                    enabled={documentSearchEnabled}
                    disabled={busy}
                    onToggle={() => setDocumentSearchEnabled((enabled) => !enabled)}
                  />
                  <OpenGeniToolToggle
                    enabled={openGeniToolEnabled}
                    disabled={busy}
                    onToggle={() => setOpenGeniToolEnabled((enabled) => !enabled)}
                  />
                  <EnabledMcpToolPicker
                    servers={customMcpServers}
                    selectedIds={selectedCapabilityToolIds}
                    disabled={busy}
                    onChange={setSelectedCapabilityToolIds}
                  />
                </div>
              }
              onSubmit={submitInitial}
            />
            <RecentSessions onSelect={selectSession} />
            <ScheduledTasksPanel
              clientConfig={clientConfig}
              resources={buildResources(manualRepos, githubRepos, selectedRepoIds, selectedRepoRefs)}
              githubConfigured={githubStatus?.configured === true}
              githubRepos={githubRepos}
              repositoryGroups={repositoryGroups}
              repoBusy={repoBusy}
              onRefreshRepositories={refreshGitHub}
              model={model}
              reasoningEffort={reasoningEffort}
              onSelectSession={selectSession}
            />
          </div>
        </div>
      ) : (
        <div className={cn("grid min-h-0 w-full min-w-0 flex-1 grid-cols-1 overflow-hidden", inspectorOpen && "lg:grid-cols-[minmax(0,1fr)_minmax(0,390px)]")}>
          <SessionChatPane
            conversation={conversation}
            approvals={approvals}
            busy={busy}
            canSendFollowUp={canSendFollowUp}
            session={session}
            sessionRunning={sessionRunning}
            fileUploadsEnabled={clientConfig?.fileUploads.enabled === true}
            documentSearchEnabled={documentSearchEnabled}
            openGeniToolEnabled={openGeniToolEnabled}
            customMcpServers={customMcpServers}
            selectedCapabilityToolIds={selectedCapabilityToolIds}
            clientConfig={clientConfig}
            model={model}
            reasoningEffort={reasoningEffort}
            onDocumentSearchToggle={() => setDocumentSearchEnabled((enabled) => !enabled)}
            onOpenGeniToolToggle={() => setOpenGeniToolEnabled((enabled) => !enabled)}
            onCapabilityToolIdsChange={setSelectedCapabilityToolIds}
            onModelChange={setModel}
            onReasoningEffortChange={setReasoningEffort}
            onSubmit={submitFollowUp}
            onInterrupt={interruptSession}
            onApprove={(approvalId) => void sendApproval(session.id, approvalId, "approve")}
            onReject={(approvalId) => void sendApproval(session.id, approvalId, "reject")}
          />

          {inspectorOpen ? (
            <aside className="min-h-0 w-full min-w-0 overflow-hidden border-t border-[color:var(--color-border)] bg-[color:var(--color-surface)]/35 lg:border-t-0 lg:border-l">
              <SessionInspector session={session} events={events} connectionState={connectionState} />
            </aside>
          ) : null}
        </div>
      )}
        </>
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

export function applySessionStatusEvents(session: Session, events: SessionEvent[]): Session {
  return events.reduce((current, event) => {
    if (event.type !== "session.status.changed" || event.sessionId !== current.id) {
      return current;
    }
    const status = (event.payload as { status?: unknown }).status;
    if (!isSessionStatus(status)) {
      return current;
    }
    return {
      ...current,
      status,
      activeTurnId: status === "idle" || status === "failed" || status === "cancelled" ? null : current.activeTurnId,
      updatedAt: event.occurredAt,
    };
  }, session);
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return value === "queued" ||
    value === "running" ||
    value === "idle" ||
    value === "requires_action" ||
    value === "failed" ||
    value === "cancelled";
}

function RepositoryContextPicker(props: {
  configured: boolean;
  installUrl: string | null;
  repositories: GitHubRepository[];
  groups: ReturnType<typeof groupRepositories>;
  selectedRepoIds: Set<number>;
  selectedRepoRefs: Record<number, string>;
  selectedInstallationId: number | null;
  manualRepos: RepoDraft[];
  manualOpen: boolean;
  githubAppOpen: boolean;
  org: string;
  pending: boolean;
  repoBusy: boolean;
  githubAppBusy: boolean;
  onRefresh: () => Promise<void>;
  onToggleRepo: (repo: GitHubRepository) => void;
  onRefChange: (repoId: number, ref: string) => void;
  onManualOpenChange: (open: boolean) => void;
  onManualAdd: () => void;
  onManualUpdate: (id: number, patch: Partial<RepoDraft>) => void;
  onManualRemove: (id: number) => void;
  onGitHubAppOpenChange: (open: boolean) => void;
  onOrgChange: (value: string) => void;
  onStartGitHubApp: () => void;
}) {
  const selectedInstalledCount = props.selectedRepoIds.size;
  const manualCount = props.manualRepos.filter((repo) => repo.url.trim().length > 0).length;
  const selectedCount = selectedInstalledCount + manualCount;
  const setupOpen = props.githubAppOpen;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.pending}
          aria-label="Repository context"
          className={cn(
            "h-8 max-w-[13rem] gap-1.5 rounded-full border border-transparent px-2.5 text-xs",
            "text-[color:var(--color-fg-muted)] hover:border-[color:var(--color-border)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-fg)]",
            selectedCount > 0 && "border-[color:var(--color-brand)]/35 bg-[color:var(--color-brand)]/10 text-[color:var(--color-fg)]",
          )}
        >
          <GitBranchIcon className="size-3.5" />
          <span className="truncate">{selectedCount > 0 ? repoCountLabel(selectedCount) : "Repos"}</span>
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              props.configured ? "bg-emerald-400" : "bg-amber-400",
            )}
            aria-hidden="true"
          />
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-xl border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-0 shadow-2xl"
      >
        <div onKeyDown={(event) => event.stopPropagation()}>
          <div className="flex items-center justify-between gap-3 border-b border-[color:var(--color-border)] px-3 py-2.5">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-[color:var(--color-fg)]">Repository context</div>
              <div className="mt-0.5 truncate text-[11px] text-[color:var(--color-fg-subtle)]">
                {selectedCount > 0 ? `${repoCountLabel(selectedCount)} selected for this session` : "Optional repositories for the sandbox"}
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => void props.onRefresh()}
              disabled={!props.configured || props.repoBusy}
              aria-label="Refresh repositories"
              className="size-7"
            >
              <RefreshCwIcon className={cn("size-3.5", props.repoBusy && "animate-spin")} />
            </Button>
          </div>

          <ScrollArea className="max-h-[min(70vh,620px)]">
            <div className="space-y-3 p-3">
              <Collapsible open={setupOpen} onOpenChange={props.onGitHubAppOpenChange}>
                <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/25">
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-[color:var(--color-surface-2)]/60"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-[color:var(--color-fg)]">GitHub App</span>
                        <span className="mt-0.5 block truncate text-[11px] text-[color:var(--color-fg-subtle)]">
                          {props.configured ? "Configured for scoped repository tokens" : "Set up GitHub App access"}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span
                          className={cn(
                            "rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                            props.configured
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                              : "border-amber-500/30 bg-amber-500/10 text-amber-200",
                          )}
                        >
                          {props.configured ? "Ready" : "Setup"}
                        </span>
                        <ChevronDownIcon className={cn("size-3.5 text-[color:var(--color-fg-subtle)] transition-transform", setupOpen && "rotate-180")} />
                      </span>
                    </button>
                  </CollapsibleTrigger>

                  <CollapsibleContent>
                    <div className="space-y-3 border-t border-[color:var(--color-border)] p-3">
                      <p className="text-xs leading-5 text-[color:var(--color-fg-muted)]">
                        {props.configured
                          ? "The app is used for repository listing, scoped clone tokens, pushes, and pull requests."
                          : "Create a prefilled app, add the generated values to .env, then restart API and worker."}
                      </p>
                      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                        <div className="min-w-0">
                          <Label htmlFor="github-org-menu" className="text-[11px] text-[color:var(--color-fg-subtle)]">Organization</Label>
                          <Input
                            id="github-org-menu"
                            value={props.org}
                            onChange={(event) => props.onOrgChange(event.target.value)}
                            placeholder="Optional org login"
                            disabled={props.githubAppBusy}
                            className="mt-1 h-8 text-xs"
                          />
                        </div>
                        <div className="flex items-end gap-1.5">
                          {props.installUrl ? (
                            <Button asChild type="button" variant="outline" size="sm" className="h-8 text-xs">
                              <a href={props.installUrl}>
                                <GitPullRequestIcon className="size-3.5" />
                                Install
                              </a>
                            </Button>
                          ) : null}
                          <Button type="button" size="sm" onClick={props.onStartGitHubApp} disabled={props.githubAppBusy} className="h-8 text-xs">
                            {props.githubAppBusy ? <Loader2Icon className="size-3.5 animate-spin" /> : <GitPullRequestIcon className="size-3.5" />}
                            {props.configured ? "Create another" : "Create app"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>

              <section className="overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/25">
                <div className="flex items-center justify-between gap-3 border-b border-[color:var(--color-border)] px-3 py-2">
                  <div className="text-xs font-medium text-[color:var(--color-fg)]">Installed repositories</div>
                  <div className="text-[11px] text-[color:var(--color-fg-subtle)]">
                    {props.configured ? `${props.repositories.length} available` : "GitHub not configured"}
                  </div>
                </div>

                {!props.configured ? (
                  <div className="p-3 text-xs leading-5 text-[color:var(--color-fg-muted)]">
                    Configure and install the GitHub App to select repositories.
                  </div>
                ) : props.repoBusy ? (
                  <div className="flex items-center gap-2 p-3 text-xs text-[color:var(--color-fg-muted)]">
                    <Loader2Icon className="size-3.5 animate-spin" />
                    Loading repositories
                  </div>
                ) : props.repositories.length === 0 ? (
                  <div className="p-3 text-xs leading-5 text-[color:var(--color-fg-muted)]">
                    No installed repositories found. Install the app on a repository, then refresh.
                  </div>
                ) : (
                  <div className="max-h-80 overflow-auto">
                    {props.groups.map((group) => (
                      <div key={group.installationId} className="border-b border-[color:var(--color-border)] last:border-b-0">
                        <div className="flex items-center justify-between gap-3 bg-[color:var(--color-surface)]/45 px-3 py-1.5">
                          <div className="min-w-0 truncate text-[11px] font-medium text-[color:var(--color-fg-muted)]">{group.label}</div>
                          <div className="shrink-0 text-[10px] uppercase tracking-wide text-[color:var(--color-fg-subtle)]">{group.repositories.length} repos</div>
                        </div>
                        <div className="divide-y divide-[color:var(--color-border)]/70">
                          {group.repositories.map((repo) => {
                            const checked = props.selectedRepoIds.has(repo.id);
                            const blocked = props.selectedInstallationId !== null && props.selectedInstallationId !== repo.installationId && !checked;
                            return (
                              <div key={`${repo.installationId}:${repo.id}`} className={cn("px-2 py-2 transition-colors hover:bg-[color:var(--color-surface-2)]/45", blocked && "opacity-55")}>
                                <button
                                  type="button"
                                  onClick={() => props.onToggleRepo(repo)}
                                  disabled={props.pending}
                                  aria-pressed={checked}
                                  aria-label={`Select ${repo.fullName}`}
                                  className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md text-left outline-none"
                                >
                                  <span
                                    className={cn(
                                      "flex size-4 items-center justify-center rounded border",
                                      checked
                                        ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-strong)] text-[color:var(--color-brand-fg)]"
                                        : "border-[color:var(--color-border-strong)] bg-[color:var(--color-surface)]",
                                    )}
                                  >
                                    {checked ? <CheckIcon className="size-3" /> : null}
                                  </span>
                                  <span className="min-w-0">
                                    <span className="flex min-w-0 items-center gap-1.5">
                                      <span className="truncate text-xs font-medium text-[color:var(--color-fg)]">{repo.fullName}</span>
                                      {repo.private ? <LockIcon className="size-3 shrink-0 text-[color:var(--color-fg-subtle)]" /> : null}
                                    </span>
                                    <span className="mt-0.5 block truncate text-[11px] text-[color:var(--color-fg-subtle)]">
                                      default {repo.defaultBranch}
                                    </span>
                                  </span>
                                  {blocked ? (
                                    <span className="rounded-full border border-amber-500/30 px-1.5 py-0.5 text-[10px] text-amber-200">other app</span>
                                  ) : checked ? (
                                    <span className="rounded-full border border-emerald-500/30 px-1.5 py-0.5 text-[10px] text-emerald-300">selected</span>
                                  ) : null}
                                </button>
                                {checked ? (
                                  <div className="mt-2 flex items-center gap-2 pl-6">
                                    <GitBranchIcon className="size-3.5 shrink-0 text-[color:var(--color-fg-subtle)]" />
                                    <Input
                                      value={props.selectedRepoRefs[repo.id] ?? repo.defaultBranch}
                                      onChange={(event) => props.onRefChange(repo.id, event.target.value)}
                                      onClick={(event) => event.stopPropagation()}
                                      disabled={props.pending}
                                      placeholder={repo.defaultBranch}
                                      aria-label={`${repo.fullName} ref`}
                                      className="h-7 text-xs"
                                    />
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <Collapsible open={props.manualOpen} onOpenChange={props.onManualOpenChange}>
                <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/25">
                  <div className="flex items-center justify-between gap-2 px-3 py-2">
                    <CollapsibleTrigger asChild>
                      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left text-xs font-medium text-[color:var(--color-fg)]">
                        <ChevronDownIcon className={cn("size-3.5 shrink-0 text-[color:var(--color-fg-subtle)] transition-transform", props.manualOpen && "rotate-180")} />
                        <span className="truncate">Manual repositories</span>
                        {manualCount > 0 ? <span className="rounded-full border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-subtle)]">{manualCount}</span> : null}
                      </button>
                    </CollapsibleTrigger>
                    <Button type="button" variant="ghost" size="xs" onClick={props.onManualAdd} disabled={props.pending} className="h-7 text-xs">
                      <PlusIcon className="size-3" />
                      Add URL
                    </Button>
                  </div>

                  <CollapsibleContent>
                    <div className="space-y-2 border-t border-[color:var(--color-border)] p-3">
                      {props.manualRepos.length === 0 ? (
                        <p className="text-xs leading-5 text-[color:var(--color-fg-muted)]">
                          Add HTTPS Git repositories that do not use the GitHub App token.
                        </p>
                      ) : (
                        props.manualRepos.map((repo) => (
                          <div key={repo.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_auto]">
                            <Input
                              value={repo.url}
                              onChange={(event) => props.onManualUpdate(repo.id, { url: event.target.value })}
                              disabled={props.pending}
                              placeholder="https://github.com/org/repo"
                              className="h-8 text-xs"
                            />
                            <div className="relative">
                              <GitBranchIcon className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-[color:var(--color-fg-subtle)]" />
                              <Input
                                value={repo.ref}
                                onChange={(event) => props.onManualUpdate(repo.id, { ref: event.target.value })}
                                disabled={props.pending}
                                placeholder="main"
                                className="h-8 pl-7 text-xs"
                              />
                            </div>
                            <Button type="button" variant="ghost" size="icon-sm" onClick={() => props.onManualRemove(repo.id)} disabled={props.pending} aria-label="Remove repository" className="size-8">
                              <Trash2Icon className="size-3.5" />
                            </Button>
                          </div>
                        ))
                      )}
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            </div>
          </ScrollArea>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type CapabilityFilter = "all" | CapabilityKind;

function CapabilitiesWorkspace({ onRuntimeChanged }: { onRuntimeChanged: () => void }) {
  const [items, setItems] = useState<CapabilityCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<CapabilityFilter>("all");
  const [query, setQuery] = useState("");
  const [registryQuery, setRegistryQuery] = useState("");
  const [registryBusy, setRegistryBusy] = useState(false);
  const [registryResults, setRegistryResults] = useState<CapabilityCatalogItem[]>([]);
  const [addForm, setAddForm] = useState<CapabilityFormState>(() => emptyCapabilityForm());
  const visibleItems = useMemo(() => filterCapabilityCatalogItems(items, filter, query), [items, filter, query]);
  const counts = useMemo(() => capabilityCounts(items), [items]);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const catalog = await fetchCapabilities();
      setItems(catalog.items);
    } catch (error) {
      toast.error("Failed to load capabilities", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }

  async function toggleCapability(item: CapabilityCatalogItem) {
    setBusyId(item.id);
    try {
      if (item.enabled && item.source !== "built_in" && item.source !== "configured") {
        await disableCapability(item.id);
        toast.success("Capability disabled");
      } else if (!item.enabled) {
        await enableCapability(item.id);
        toast.success("Capability enabled");
      }
      await refresh();
      if (item.kind === "mcp") {
        onRuntimeChanged();
      }
    } catch (error) {
      const copy = capabilityErrorToast(error, "Capability update failed");
      toast.error(copy.title, { description: copy.description });
    } finally {
      setBusyId(null);
    }
  }

  async function searchRegistry() {
    setRegistryBusy(true);
    try {
      setRegistryResults(await discoverMcpRegistryCapabilities({ query: registryQuery, limit: 30 }));
    } catch (error) {
      toast.error("MCP Registry search failed", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setRegistryBusy(false);
    }
  }

  async function addRegistryItem(item: CapabilityCatalogItem, enableAfterAdd: boolean) {
    setBusyId(item.id);
    try {
      const created = await createCapability(createInputFromCatalogItem(item));
      if (enableAfterAdd) {
        await enableCapability(created.id);
      }
      await refresh();
      if (enableAfterAdd) {
        onRuntimeChanged();
      }
      toast.success(enableAfterAdd ? "Public MCP added and enabled" : "Public MCP added");
    } catch (error) {
      const copy = capabilityErrorToast(error, "Failed to add public MCP");
      toast.error(copy.title, { description: copy.description });
    } finally {
      setBusyId(null);
    }
  }

  async function submitManualCapability() {
    const input = capabilityInputFromForm(addForm);
    if (!input) {
      toast.error("Capability name is required");
      return;
    }
    setBusyId("new");
    try {
      const created = await createCapability(input);
      if (addForm.enableAfterAdd) {
        await enableCapability(created.id);
      }
      setAddForm(emptyCapabilityForm());
      await refresh();
      if (created.kind === "mcp" && addForm.enableAfterAdd) {
        onRuntimeChanged();
      }
      toast.success(addForm.enableAfterAdd ? "Capability added and enabled" : "Capability added");
    } catch (error) {
      const copy = capabilityErrorToast(error, "Failed to add capability");
      toast.error(copy.title, { description: copy.description });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col text-left">
      <div className="flex flex-col gap-3 border-b border-[color:var(--color-border)] pb-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-base font-semibold">
            <PlugIcon className="size-4 text-[color:var(--color-brand)]" />
            Capabilities
          </div>
          <p className="mt-1 text-sm leading-5 text-[color:var(--color-fg-muted)]">
            Enable packs, MCPs, APIs, skills, and plugins for this workspace.
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1 sm:flex-none">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-[color:var(--color-fg-subtle)]" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search catalog" className="h-9 pl-8 text-sm" />
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading} className="h-9">
            <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {(["all", "pack", "mcp", "api", "skill", "plugin"] as CapabilityFilter[]).map((kind) => (
          <Button
            key={kind}
            type="button"
            variant={filter === kind ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setFilter(kind)}
            className="h-8 text-xs"
          >
            {capabilityKindIcon(kind)}
            {capabilityFilterLabel(kind)}
            <span className="ml-1 rounded-full border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-subtle)]">{counts[kind]}</span>
          </Button>
        ))}
      </div>

      <div className="mt-5 grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
        <div className="min-w-0">
          {loading ? (
            <div className="flex items-center gap-2 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-4 text-sm text-[color:var(--color-fg-muted)]">
              <Loader2Icon className="size-4 animate-spin" />
              Loading capabilities
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[color:var(--color-border)] p-6 text-center text-sm text-[color:var(--color-fg-muted)]">
              No capabilities match this filter.
            </div>
          ) : (
            <div className="grid gap-2">
              {visibleItems.map((item) => (
                <CapabilityRow
                  key={item.id}
                  item={item}
                  busy={busyId === item.id}
                  onToggle={() => void toggleCapability(item)}
                />
              ))}
            </div>
          )}
        </div>

        <aside className="min-w-0 space-y-4 border-t border-[color:var(--color-border)] pt-4 xl:border-t-0 xl:border-l xl:pl-4 xl:pt-0">
          <section className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <GlobeIcon className="size-4 text-[color:var(--color-brand)]" />
              Public MCP Registry
            </div>
            <div className="mt-3 flex gap-2">
              <Input
                value={registryQuery}
                onChange={(event) => setRegistryQuery(event.target.value)}
                placeholder="Search remote MCPs"
                className="h-8 text-xs"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void searchRegistry();
                }}
              />
              <Button type="button" size="sm" disabled={registryBusy} onClick={() => void searchRegistry()} className="h-8 shrink-0 text-xs">
                {registryBusy ? <Loader2Icon className="size-3.5 animate-spin" /> : <SearchIcon className="size-3.5" />}
                Search
              </Button>
            </div>
            <div className="mt-3 max-h-[28rem] space-y-2 overflow-auto pr-1">
              {registryResults.length === 0 ? (
                <div className="rounded-md border border-dashed border-[color:var(--color-border)] p-3 text-xs leading-5 text-[color:var(--color-fg-muted)]">
                  Search returns public remote MCP servers that expose streamable HTTP endpoints.
                </div>
              ) : registryResults.map((item) => (
                <div key={item.id} className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/35 p-2">
                  <div className="min-w-0 truncate text-xs font-medium">{item.name}</div>
                  {item.description ? <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-[color:var(--color-fg-muted)]">{item.description}</p> : null}
                  <div className="mt-2 truncate font-mono text-[10px] text-[color:var(--color-fg-subtle)]">{item.endpointUrl}</div>
                  <div className="mt-2 flex justify-end gap-1.5">
                    <Button type="button" variant="ghost" size="xs" disabled={busyId === item.id} onClick={() => void addRegistryItem(item, false)}>
                      <PlusIcon className="size-3" />
                      Add
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      disabled={busyId === item.id || !item.runtime.available}
                      title={!item.runtime.available ? item.runtime.notes ?? "This MCP is not available for runtime use yet." : undefined}
                      onClick={() => void addRegistryItem(item, true)}
                    >
                      {busyId === item.id ? <Loader2Icon className="size-3 animate-spin" /> : <CheckIcon className="size-3" />}
                      Enable
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <PlusIcon className="size-4 text-[color:var(--color-brand)]" />
              Add Capability
            </div>
            <div className="mt-3 grid gap-2">
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                <select
                  className="h-8 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-xs"
                  value={addForm.kind}
                  onChange={(event) => setAddForm((current) => ({ ...current, kind: event.target.value as CapabilityFormState["kind"] }))}
                >
                  <option value="mcp">MCP</option>
                  <option value="api">API</option>
                  <option value="skill">Skill</option>
                  <option value="plugin">Plugin</option>
                </select>
                <Input value={addForm.name} onChange={(event) => setAddForm((current) => ({ ...current, name: event.target.value }))} placeholder="Name" className="h-8 text-xs" />
              </div>
              <Input value={addForm.endpointUrl} onChange={(event) => setAddForm((current) => ({ ...current, endpointUrl: event.target.value }))} placeholder="Endpoint URL" className="h-8 text-xs" />
              <Input value={addForm.homepageUrl} onChange={(event) => setAddForm((current) => ({ ...current, homepageUrl: event.target.value }))} placeholder="Homepage URL" className="h-8 text-xs" />
              <Input value={addForm.installUrl} onChange={(event) => setAddForm((current) => ({ ...current, installUrl: event.target.value }))} placeholder="Install URL" className="h-8 text-xs" />
              <Input value={addForm.category} onChange={(event) => setAddForm((current) => ({ ...current, category: event.target.value }))} placeholder="Category" className="h-8 text-xs" />
              <Input value={addForm.tags} onChange={(event) => setAddForm((current) => ({ ...current, tags: event.target.value }))} placeholder="Tags, comma separated" className="h-8 text-xs" />
              <textarea
                value={addForm.description}
                onChange={(event) => setAddForm((current) => ({ ...current, description: event.target.value }))}
                placeholder="Description"
                className="min-h-16 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-xs"
              />
              <label className="flex items-center gap-2 text-xs text-[color:var(--color-fg-muted)]">
                <input
                  type="checkbox"
                  checked={addForm.enableAfterAdd}
                  onChange={(event) => setAddForm((current) => ({ ...current, enableAfterAdd: event.target.checked }))}
                />
                Enable after adding
              </label>
              <Button type="button" onClick={() => void submitManualCapability()} disabled={busyId === "new"} className="h-8">
                {busyId === "new" ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
                Add capability
              </Button>
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

function CapabilityRow({ item, busy, onToggle }: {
  item: CapabilityCatalogItem;
  busy: boolean;
  onToggle: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const canToggle = item.enabled
    ? item.kind === "pack" || (item.source !== "built_in" && item.source !== "configured")
    : item.kind !== "mcp" || item.runtime.available;
  const toggleTitle = !canToggle && item.kind === "mcp"
    ? item.runtime.notes ?? "This MCP is not available for runtime use yet."
    : undefined;
  const packContents = summarizePackContents(item);
  return (
    <article className="grid min-w-0 gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-3 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] text-[color:var(--color-brand)]">
            {capabilityKindIcon(item.kind)}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-sm font-medium">{item.name}</h3>
              <CapabilityStatusPill enabled={item.enabled} source={item.source} reason={item.enabledReason} />
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap gap-1.5 text-[11px] text-[color:var(--color-fg-subtle)]">
              <span>{item.kind}</span>
              <span>{item.source.replaceAll("_", " ")}</span>
              <span>{item.category}</span>
              {item.runtime.mcpServerId ? <span className="font-mono">{item.runtime.mcpServerId}</span> : null}
            </div>
          </div>
        </div>
        {item.description ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-[color:var(--color-fg-muted)]">{item.description}</p> : null}
        <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
          {item.tags.slice(0, 5).map((tag) => (
            <span key={tag} className="max-w-full truncate rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-subtle)]">{tag}</span>
          ))}
          {item.endpointUrl ? <CapabilityLink href={item.endpointUrl} label="endpoint" /> : null}
          {item.homepageUrl ? <CapabilityLink href={item.homepageUrl} label="home" /> : null}
          {item.installUrl && item.installUrl !== item.homepageUrl ? <CapabilityLink href={item.installUrl} label="install" /> : null}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        {packContents?.hasContents ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((current) => !current)}
            className="h-8 text-xs"
            aria-expanded={expanded}
          >
            <ChevronDownIcon className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
            Contents
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant={item.enabled ? "secondary" : "default"}
          disabled={busy || !canToggle}
          onClick={onToggle}
          className="h-8 min-w-24 text-xs"
          title={toggleTitle}
        >
          {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : item.enabled ? <CheckIcon className="size-3.5" /> : <PlusIcon className="size-3.5" />}
          {item.enabled ? (canToggle ? "Disable" : "Ready") : "Enable"}
        </Button>
      </div>
      {packContents && expanded ? <PackContentsPanel contents={packContents} /> : null}
    </article>
  );
}

function PackContentsPanel({ contents }: { contents: PackContentsSummary }) {
  return (
    <div className="grid gap-3 border-t border-[color:var(--color-border)] pt-3 lg:col-span-2 md:grid-cols-2">
      <PackContentsSection title="MCPs">
        {contents.mcpServerIds.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {contents.mcpServerIds.map((id) => (
              <span key={id} className="rounded border border-[color:var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--color-fg-subtle)]">{id}</span>
            ))}
          </div>
        ) : <PackEmptyText />}
        {contents.firstPartyMcpTools.length > 0 ? (
          <div className="mt-2 text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">
            Tools: {contents.firstPartyMcpTools.join(", ")}
          </div>
        ) : null}
      </PackContentsSection>

      <PackContentsSection title="Skills">
        {contents.skills.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {contents.skills.map((skill) => (
              <span key={skill} className="rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-subtle)]">{skill}</span>
            ))}
          </div>
        ) : <PackEmptyText />}
      </PackContentsSection>

      <PackContentsSection title="Connectors">
        {contents.connectors.length > 0 ? (
          <div className="grid gap-2">
            {contents.connectors.map((connector) => (
              <div key={connector.id} className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate text-xs font-medium">{connector.name}</span>
                  {connector.required ? <span className="rounded border border-amber-500/30 px-1.5 py-0.5 text-[10px] text-amber-300">required</span> : null}
                </div>
                <div className="mt-0.5 text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">
                  {[connector.authModel, connector.providers.join(", "), connector.scopes.length ? `${connector.scopes.length} scopes` : null].filter(Boolean).join(" / ")}
                </div>
              </div>
            ))}
          </div>
        ) : <PackEmptyText />}
      </PackContentsSection>

      <PackContentsSection title="Knowledge">
        {contents.knowledge.length > 0 ? (
          <div className="grid gap-2">
            {contents.knowledge.map((knowledge) => (
              <div key={knowledge.id} className="min-w-0">
                <div className="truncate text-xs font-medium">{knowledge.name}</div>
                {knowledge.description ? <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">{knowledge.description}</div> : null}
              </div>
            ))}
          </div>
        ) : <PackEmptyText />}
      </PackContentsSection>

      <PackContentsSection title="Schedules">
        {contents.scheduledTaskTemplates.length > 0 ? (
          <div className="grid gap-2">
            {contents.scheduledTaskTemplates.map((template) => (
              <div key={template.id} className="min-w-0">
                <div className="truncate text-xs font-medium">{template.name}</div>
                <div className="mt-0.5 text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">{template.scheduleSummary}</div>
              </div>
            ))}
          </div>
        ) : <PackEmptyText />}
      </PackContentsSection>
    </div>
  );
}

function PackContentsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="mb-1.5 text-[11px] font-semibold text-[color:var(--color-fg-subtle)]">{title}</div>
      {children}
    </section>
  );
}

function PackEmptyText() {
  return <div className="text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">None declared.</div>;
}

function CapabilityStatusPill(props: { enabled: boolean; source: string; reason: string | null }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        props.enabled
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          : "border-[color:var(--color-border)] bg-[color:var(--color-bg)] text-[color:var(--color-fg-subtle)]",
      )}
    >
      {props.enabled ? props.reason ?? "enabled" : props.source === "manual" ? "added" : "available"}
    </span>
  );
}

function CapabilityLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="max-w-full truncate rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-brand)] hover:bg-[color:var(--color-surface-2)]">
      {label}
    </a>
  );
}

function DocumentsWorkspace({ fileUploadsEnabled }: { fileUploadsEnabled: boolean }) {
  const [bases, setBases] = useState<DocumentBase[]>([]);
  const [selectedBaseId, setSelectedBaseId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<IndexedDocument[]>([]);
  const [results, setResults] = useState<DocumentSearchResult[]>([]);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [creatingBase, setCreatingBase] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(() => new Set());
  const [retryingAll, setRetryingAll] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectedBase = bases.find((base) => base.id === selectedBaseId) ?? null;
  const failedDocuments = documents.filter((document) => document.status === "failed");

  useEffect(() => {
    void refreshBases();
  }, []);

  useEffect(() => {
    if (!selectedBaseId) {
      setDocuments([]);
      setResults([]);
      return;
    }
    void fetchDocuments(selectedBaseId).then(setDocuments).catch((error) => {
      toast.error("Failed to load documents", { description: String(error) });
    });
  }, [selectedBaseId]);

  useEffect(() => {
    if (!selectedBaseId || !documents.some((document) => document.status === "queued" || document.status === "indexing")) {
      return;
    }
    const timer = window.setInterval(() => {
      void fetchDocuments(selectedBaseId).then(setDocuments).catch(() => undefined);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [selectedBaseId, documents]);

  async function refreshBases() {
    try {
      const next = await fetchDocumentBases();
      setBases(next);
      setSelectedBaseId((current) => current ?? next[0]?.id ?? null);
    } catch (error) {
      toast.error("Failed to load document bases", { description: String(error) });
    }
  }

  async function handleCreateBase() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreatingBase(true);
    try {
      const base = await createDocumentBase({ name: trimmed });
      setBases((current) => [...current, base]);
      setSelectedBaseId(base.id);
      setName("");
    } catch (error) {
      toast.error("Failed to create document base", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setCreatingBase(false);
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!selectedBaseId || !files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const asset = await uploadFileAsset(file);
        const indexed = await addDocumentToBase(selectedBaseId, asset.id);
        setDocuments((current) => [indexed, ...current.filter((item) => item.id !== indexed.id)]);
      }
      toast.success("Document indexed");
    } catch (error) {
      toast.error("Failed to index document", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleSearch() {
    if (!selectedBaseId || !query.trim()) return;
    setSearching(true);
    try {
      setResults(await searchDocumentBase(selectedBaseId, query.trim()));
    } catch (error) {
      toast.error("Document search failed", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSearching(false);
    }
  }

  async function retryDocument(document: IndexedDocument): Promise<IndexedDocument> {
    setRetryingIds((current) => new Set(current).add(document.id));
    try {
      const indexed = await reindexDocument(document.id);
      setDocuments((current) => [indexed, ...current.filter((item) => item.id !== indexed.id)]);
      return indexed;
    } finally {
      setRetryingIds((current) => {
        const next = new Set(current);
        next.delete(document.id);
        return next;
      });
    }
  }

  async function handleRetryDocument(document: IndexedDocument) {
    try {
      await retryDocument(document);
      toast.success("Document retry started");
    } catch (error) {
      toast.error("Failed to retry document", { description: error instanceof Error ? error.message : String(error) });
    }
  }

  async function handleRetryFailedDocuments() {
    if (failedDocuments.length === 0) return;
    setRetryingAll(true);
    try {
      for (const document of failedDocuments) {
        await retryDocument(document);
      }
      toast.success(`Retry started for ${failedDocuments.length} failed ${failedDocuments.length === 1 ? "document" : "documents"}`);
    } catch (error) {
      toast.error("Failed to retry documents", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setRetryingAll(false);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col text-left">
      <div className="flex flex-col gap-3 border-b border-[color:var(--color-border)] pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-base font-semibold">
            <FileSearchIcon className="size-4 text-[color:var(--color-brand)]" />
            Documents
          </div>
          <p className="mt-1 text-sm leading-5 text-[color:var(--color-fg-muted)]">
            Manage indexed document bases for agent search and retry failed document indexing.
          </p>
        </div>
        <div className="flex min-w-0 gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="New base"
            className="h-8 min-w-0 text-xs"
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleCreateBase();
            }}
          />
          <Button type="button" size="sm" onClick={handleCreateBase} disabled={creatingBase || !name.trim()} className="h-8 shrink-0">
            {creatingBase ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
            Create
          </Button>
        </div>
      </div>

      <div className="mt-5 grid min-h-0 flex-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)_360px]">
        <aside className="min-w-0 border-b border-[color:var(--color-border)] pb-4 lg:border-b-0 lg:border-r lg:pr-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-xs font-medium uppercase text-[color:var(--color-fg-subtle)]">Bases</div>
            <div className="text-[11px] text-[color:var(--color-fg-subtle)]">{bases.length}</div>
          </div>
          <div className="space-y-1">
            {bases.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[color:var(--color-border)] p-3 text-xs text-[color:var(--color-fg-muted)]">
                Create a document base to start.
              </div>
            ) : bases.map((base) => (
              <button
                key={base.id}
                type="button"
                onClick={() => setSelectedBaseId(base.id)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs",
                  selectedBaseId === base.id
                    ? "border-[color:var(--color-brand)]/40 bg-[color:var(--color-brand)]/10 text-[color:var(--color-fg)]"
                    : "border-[color:var(--color-border)] bg-[color:var(--color-bg)]/25 text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-surface-2)]",
                )}
              >
                <span className="truncate">{base.name}</span>
                {selectedBaseId === base.id ? <CheckIcon className="size-3.5 shrink-0" /> : null}
              </button>
            ))}
          </div>
        </aside>

        <div className="min-w-0">
          {selectedBase ? (
            <>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="truncate text-base font-medium">{selectedBase.name}</div>
                  <div className="text-xs text-[color:var(--color-fg-subtle)]">
                    {documents.length} files · {failedDocuments.length} failed
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(event) => void handleFiles(event.target.files)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={uploading || !fileUploadsEnabled}
                    onClick={() => fileInputRef.current?.click()}
                    className="h-8"
                  >
                    {uploading ? <Loader2Icon className="size-3.5 animate-spin" /> : <FilesIcon className="size-3.5" />}
                    Upload
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={retryingAll || failedDocuments.length === 0}
                    onClick={() => void handleRetryFailedDocuments()}
                    className="h-8"
                  >
                    {retryingAll ? <Loader2Icon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
                    Retry failed
                  </Button>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                {documents.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[color:var(--color-border)] p-6 text-center text-xs text-[color:var(--color-fg-muted)]">
                    Upload files to index this base.
                  </div>
                ) : (
                  documents.map((document) => (
                    <div key={document.id} className="flex items-start justify-between gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/35 px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{document.title}</div>
                        <div className="mt-1 text-[11px] text-[color:var(--color-fg-subtle)]">
                          {document.status} · {document.chunkCount} chunks · {document.parser}
                        </div>
                        {document.status === "failed" && document.error ? (
                          <div className="mt-2 line-clamp-2 max-w-3xl text-xs leading-5 text-[color:var(--color-danger)]">
                            {document.error}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2 pt-0.5">
                        <StatusDot status={document.status} />
                        {document.status === "failed" ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={retryingIds.has(document.id)}
                            onClick={() => void handleRetryDocument(document)}
                            aria-label={`Retry ${document.title}`}
                            title="Retry indexing"
                          >
                            {retryingIds.has(document.id) ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <div className="grid min-h-48 place-items-center text-center text-xs text-[color:var(--color-fg-muted)]">
              Select or create a base.
            </div>
          )}
        </div>

        <aside className="min-w-0 border-t border-[color:var(--color-border)] pt-4 lg:border-t-0 lg:border-l lg:pl-4 lg:pt-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <FileSearchIcon className="size-4 text-[color:var(--color-brand)]" />
            Search
          </div>
          <div className="mt-3 grid gap-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search indexed documents"
              className="h-9 text-sm"
              disabled={!selectedBaseId}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleSearch();
              }}
            />
            <Button type="button" size="sm" onClick={handleSearch} disabled={searching || !selectedBaseId || !query.trim()} className="h-9">
              {searching ? <Loader2Icon className="size-3.5 animate-spin" /> : <FileSearchIcon className="size-3.5" />}
              Search
            </Button>
          </div>

          <div className="mt-4 space-y-2">
            {results.length > 0 ? (
              results.map((result) => (
                <div key={result.chunkId} className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/35 p-3">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-medium text-[color:var(--color-fg)]">{result.title}</span>
                    <span className="shrink-0 text-[color:var(--color-fg-subtle)]">{Math.round(result.score * 100)}%</span>
                  </div>
                  <p className="mt-2 line-clamp-4 text-xs leading-5 text-[color:var(--color-fg-muted)]">{result.text}</p>
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-[color:var(--color-border)] p-4 text-xs leading-5 text-[color:var(--color-fg-muted)]">
                Search results appear here for the selected base.
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

function StatusDot({ status }: { status: IndexedDocument["status"] }) {
  return (
    <span
      className={cn(
        "size-2.5 shrink-0 rounded-full",
        status === "ready" && "bg-emerald-400",
        status === "failed" && "bg-red-400",
        (status === "queued" || status === "indexing") && "bg-amber-300",
      )}
      aria-label={status}
      title={status}
    />
  );
}

function DocumentSearchToolToggle(props: {
  enabled: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant={props.enabled ? "secondary" : "ghost"}
      size="sm"
      disabled={props.disabled}
      onClick={props.onToggle}
      aria-pressed={props.enabled}
      aria-label="Attach document search tool"
      title="Attach document search"
      className={cn(
        "h-8 max-w-[12rem] gap-1.5 rounded-full border px-2.5 text-xs",
        props.enabled
          ? "border-[color:var(--color-brand)]/35 bg-[color:var(--color-brand)]/10 text-[color:var(--color-fg)]"
          : "border-transparent text-[color:var(--color-fg-muted)] hover:border-[color:var(--color-border)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-fg)]",
      )}
    >
      <FilesIcon className="size-3.5" />
      <span className="truncate">Docs</span>
      {props.enabled ? <CheckIcon className="size-3 shrink-0" /> : null}
    </Button>
  );
}

function OpenGeniToolToggle(props: {
  enabled: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant={props.enabled ? "secondary" : "ghost"}
      size="sm"
      disabled={props.disabled}
      onClick={props.onToggle}
      aria-pressed={props.enabled}
      aria-label="Attach OpenGeni tool"
      title="Attach OpenGeni"
      className={cn(
        "h-8 max-w-[12rem] gap-1.5 rounded-full border px-2.5 text-xs",
        props.enabled
          ? "border-[color:var(--color-brand)]/35 bg-[color:var(--color-brand)]/10 text-[color:var(--color-fg)]"
          : "border-transparent text-[color:var(--color-fg-muted)] hover:border-[color:var(--color-border)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-fg)]",
      )}
    >
      <WrenchIcon className="size-3.5" />
      <span className="truncate">OpenGeni</span>
      {props.enabled ? <CheckIcon className="size-3 shrink-0" /> : null}
    </Button>
  );
}

function EnabledMcpToolPicker(props: {
  servers: Array<{ id: string; name: string }>;
  selectedIds: Set<string>;
  disabled?: boolean;
  onChange: (ids: Set<string>) => void;
}) {
  if (props.servers.length === 0) {
    return null;
  }
  const selectedCount = props.selectedIds.size;
  function toggle(id: string) {
    const next = new Set(props.selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    props.onChange(next);
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={selectedCount > 0 ? "secondary" : "ghost"}
          size="sm"
          disabled={props.disabled}
          aria-label="Enabled MCP tools"
          className={cn(
            "h-8 max-w-[12rem] gap-1.5 rounded-full border px-2.5 text-xs",
            selectedCount > 0
              ? "border-[color:var(--color-brand)]/35 bg-[color:var(--color-brand)]/10 text-[color:var(--color-fg)]"
              : "border-transparent text-[color:var(--color-fg-muted)] hover:border-[color:var(--color-border)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-fg)]",
          )}
        >
          <PlugIcon className="size-3.5" />
          <span className="truncate">{selectedCount > 0 ? `${selectedCount} tool${selectedCount === 1 ? "" : "s"}` : "Tools"}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-72 rounded-xl border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-2 shadow-xl">
        <DropdownMenuLabel className="px-2 pt-1 pb-1 text-xs font-normal text-[color:var(--color-fg-subtle)]">Enabled MCPs</DropdownMenuLabel>
        {props.servers.map((server) => (
          <DropdownMenuItem
            key={server.id}
            onSelect={(event) => {
              event.preventDefault();
              toggle(server.id);
            }}
            className="h-9 cursor-pointer rounded-md px-2 text-sm"
          >
            <span className="min-w-0 flex-1 truncate">{server.name}</span>
            <span className="ml-2 max-w-24 truncate font-mono text-[10px] text-[color:var(--color-fg-subtle)]">{server.id}</span>
            {props.selectedIds.has(server.id) ? <CheckIcon className="ml-2 size-4 shrink-0" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelPicker(props: {
  config: ClientConfig | null;
  model: string;
  effort: IntelligenceEffort;
  disabled?: boolean;
  onModelChange: (value: string) => void;
  onEffortChange: (value: IntelligenceEffort) => void;
}) {
  const allowedEfforts = props.config?.allowedReasoningEfforts.filter(isUiReasoningEffort) ?? uiReasoningEffortOrder;
  const effortOptions = uiReasoningEffortOrder.filter((option) => allowedEfforts.includes(option));
  const modelOptions = props.config?.allowedModels ?? [props.model];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.disabled}
          aria-label="Model and effort"
          className="h-8 max-w-[14rem] gap-1 rounded-full border border-transparent px-2.5 text-xs text-[color:var(--color-fg-muted)] hover:border-[color:var(--color-border)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-fg)]"
        >
          <span className="font-medium text-[color:var(--color-fg)]">{displayModel(props.model)}</span>
          <span>{labelEffort(props.effort)}</span>
          <ChevronDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-56 rounded-xl border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-2 shadow-xl">
        <DropdownMenuLabel className="px-2 pt-1 pb-1 text-xs font-normal text-[color:var(--color-fg-subtle)]">Effort</DropdownMenuLabel>
        {effortOptions.map((option) => (
          <DropdownMenuItem key={option} onSelect={() => props.onEffortChange(option)} className="h-8 cursor-pointer rounded-md px-2 text-sm">
            <span>{labelEffort(option)}</span>
            {option === props.effort ? <CheckIcon className="ml-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator className="my-2 bg-[color:var(--color-border)]" />
        <DropdownMenuLabel className="px-2 pt-0 pb-1 text-xs font-normal text-[color:var(--color-fg-subtle)]">Model</DropdownMenuLabel>
        {modelOptions.map((option) => (
          <DropdownMenuItem key={option} onSelect={() => props.onModelChange(option)} className="h-8 cursor-pointer rounded-md px-2 text-sm">
            <span>{option}</span>
            {option === props.model ? <CheckIcon className="ml-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/60 px-2.5 py-1 text-xs font-medium text-[color:var(--color-fg-muted)]">
      <span className={cn("size-2 rounded-full", statusTone(status))} />
      <span>{status}</span>
    </span>
  );
}

function SessionChatPane(props: {
  conversation: ConversationTurn[];
  approvals: Array<{ id: string; name: string; arguments?: unknown; raw?: unknown }>;
  busy: boolean;
  canSendFollowUp: boolean;
  session: Session;
  sessionRunning: boolean;
  fileUploadsEnabled: boolean;
  documentSearchEnabled: boolean;
  openGeniToolEnabled: boolean;
  customMcpServers: Array<{ id: string; name: string }>;
  selectedCapabilityToolIds: Set<string>;
  clientConfig: ClientConfig | null;
  model: string;
  reasoningEffort: IntelligenceEffort;
  onDocumentSearchToggle: () => void;
  onOpenGeniToolToggle: () => void;
  onCapabilityToolIdsChange: (ids: Set<string>) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: IntelligenceEffort) => void;
  onSubmit: (submission: TurnSubmission) => void;
  onInterrupt: () => void;
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const previousTurnCountRef = useRef(props.conversation.length);
  const lastEventKey = [
    props.conversation.at(-1)?.id ?? "empty",
    props.conversation.at(-1)?.kind ?? "none",
    props.conversation.length,
    props.approvals.length,
  ].join(":");

  function updateNearBottom() {
    const element = scrollRef.current;
    if (!element) {
      nearBottomRef.current = true;
      return;
    }
    nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
  }

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !nearBottomRef.current) {
      previousTurnCountRef.current = props.conversation.length;
      return;
    }
    const turnCountChanged = props.conversation.length !== previousTurnCountRef.current;
    previousTurnCountRef.current = props.conversation.length;
    const frame = requestAnimationFrame(() => {
      element.scrollTo({
        top: element.scrollHeight,
        behavior: turnCountChanged ? "smooth" : "auto",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [lastEventKey, props.conversation]);

  return (
    <section className="relative min-h-0 min-w-0 overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={updateNearBottom}
        className="chat-scroll-mask h-full min-h-0 overflow-y-auto overflow-x-hidden"
        data-testid="session-chat-scroll"
      >
        <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-56 sm:px-6">
          {props.conversation.length === 0 ? (
            <div className="grid min-h-[24rem] place-items-center rounded-lg border border-dashed border-[color:var(--color-border)] text-sm text-[color:var(--color-fg-subtle)]">
              Waiting for session activity
            </div>
          ) : (
            <ConversationStream turns={props.conversation} />
          )}

          {props.approvals.length > 0 ? (
            <div className="mt-6 grid gap-3">
              {props.approvals.map((approval) => (
                <div key={approval.id} className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                  <div className="text-sm font-medium">{approval.name}</div>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-[color:var(--color-bg)] p-3 text-xs text-[color:var(--color-fg-muted)]">
                    {JSON.stringify(approval.arguments ?? approval.raw ?? {}, null, 2)}
                  </pre>
                  <div className="mt-3 flex justify-end gap-2">
                    <Button size="sm" onClick={() => props.onApprove(approval.id)}>
                      <CheckIcon className="size-3.5" />
                      Approve
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => props.onReject(approval.id)}>
                      <XIcon className="size-3.5" />
                      Reject
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-[color:var(--color-bg)] to-transparent" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-[color:var(--color-bg)] via-[color:var(--color-bg)]/80 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 px-4 pb-4 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <Composer
            pending={props.busy}
            disabled={!props.canSendFollowUp}
            submitDisabled={props.sessionRunning}
            fileUploadsEnabled={props.fileUploadsEnabled}
            disabledHint={
              props.sessionRunning
                ? "Agent is running. Stop before sending."
                : props.session.status !== "idle"
                  ? `Session is ${props.session.status}.`
                  : undefined
            }
            placeholder={props.sessionRunning ? "Agent is running..." : "Send a follow-up..."}
            submitLabel={props.busy ? "Sending" : "Send"}
            submitAction={
              props.sessionRunning ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={props.onInterrupt}
                  disabled={props.busy}
                  aria-label="Interrupt"
                  className="h-8 gap-1.5 px-3"
                >
                  {props.busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <SquareIcon className="size-3.5" />}
                  <span className="text-xs font-medium">Stop</span>
                </Button>
              ) : undefined
            }
            controlsStart={
                <div className="flex min-w-0 items-center gap-1.5">
                <ModelPicker
                  config={props.clientConfig}
                  model={props.model}
                  effort={props.reasoningEffort}
                  disabled={props.busy}
                  onModelChange={props.onModelChange}
                  onEffortChange={props.onReasoningEffortChange}
                />
                <DocumentSearchToolToggle
                  enabled={props.documentSearchEnabled}
                  disabled={props.busy || !props.canSendFollowUp}
                  onToggle={props.onDocumentSearchToggle}
                />
                <OpenGeniToolToggle
                  enabled={props.openGeniToolEnabled}
                  disabled={props.busy || !props.canSendFollowUp}
                  onToggle={props.onOpenGeniToolToggle}
                />
                <EnabledMcpToolPicker
                  servers={props.customMcpServers}
                  selectedIds={props.selectedCapabilityToolIds}
                  disabled={props.busy || !props.canSendFollowUp}
                  onChange={props.onCapabilityToolIdsChange}
                />
              </div>
            }
            onSubmit={props.onSubmit}
          />
        </div>
      </div>
    </section>
  );
}

function ConversationStream({ turns }: { turns: ConversationTurn[] }) {
  return (
    <div className="space-y-3.5" data-testid="session-timeline">
      {turns.map((turn) => turn.kind === "user"
        ? <UserMessage key={turn.id} turn={turn} />
        : turn.kind === "assistant"
          ? <AssistantMessage key={turn.id} turn={turn} />
          : <ActivityMessage key={turn.id} turn={turn} />)}
    </div>
  );
}

function UserMessage({ turn }: { turn: ConversationUserTurn }) {
  const fileResources = turn.resources.filter((resource): resource is Extract<ResourceRef, { kind: "file" }> => resource.kind === "file");
  const repositoryResources = turn.resources.filter((resource): resource is Extract<ResourceRef, { kind: "repository" }> => resource.kind === "repository");
  return (
    <article className="message-in flex justify-end gap-2.5" data-testid="timeline-user">
      <div className="max-w-[82%] rounded-xl rounded-br-sm border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/75 px-3 py-2 text-[14px] leading-6">
        {fileResources.length > 0 || repositoryResources.length > 0 || turn.tools.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {fileResources.map((resource) => <MessageFileAttachment key={`${resource.fileId}:${resource.mountPath ?? ""}`} resource={resource} />)}
            {repositoryResources.map((resource) => (
              <span
                key={`${resource.uri}:${resource.ref}:${resource.mountPath ?? ""}`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-xs text-[color:var(--color-fg-muted)]"
              >
                <GitBranchIcon className="size-3.5 shrink-0" />
                <span className="truncate">{repositoryDisplayName(resource)}</span>
              </span>
            ))}
            {turn.tools.map((tool) => (
              <span
                key={`${tool.kind}:${tool.id}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-xs text-[color:var(--color-fg-muted)]"
              >
                <WrenchIcon className="size-3.5" />
                <span>{tool.id}</span>
              </span>
            ))}
          </div>
        ) : null}
        <MarkdownText text={turn.text} compact />
      </div>
      <AvatarBubble variant="user" />
    </article>
  );
}

function MessageFileAttachment({ resource }: { resource: Extract<ResourceRef, { kind: "file" }> }) {
  const [file, setFile] = useState<FileAsset | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    void fetchFileAsset(resource.fileId).then((asset) => {
      if (mounted) {
        setFile(asset);
      }
    }).catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [resource.fileId]);

  async function openFile() {
    setBusy(true);
    try {
      const signed = await fetchFileDownloadUrl(resource.fileId);
      window.open(signed.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error("Failed to open file", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const isImage = file?.contentType.startsWith("image/");
  return (
    <button
      type="button"
      onClick={openFile}
      disabled={busy}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-xs text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] disabled:opacity-60"
    >
      {isImage ? <ImageIcon className="size-3.5 shrink-0" /> : <FileJsonIcon className="size-3.5 shrink-0" />}
      <span className="truncate">{file?.filename ?? resource.fileId}</span>
      <DownloadIcon className="size-3 shrink-0" />
    </button>
  );
}

function AssistantMessage({ turn }: { turn: ConversationAssistantTurn }) {
  const hasText = turn.text.trim().length > 0;
  return (
    <article className="message-in flex justify-start gap-2.5" data-testid="timeline-assistant">
      <AvatarBubble variant="assistant" />
      <div className="min-w-0 max-w-[88%] pt-0.5 text-[15px] leading-7">
        {hasText ? (
          <div className="text-[color:var(--color-fg)]" data-testid="assistant-markdown">
            <MarkdownText text={turn.text} streaming={turn.status === "running" || turn.status === "pending"} />
            {(turn.status === "running" || turn.status === "pending") ? <StreamingCursor /> : null}
          </div>
        ) : turn.status === "failed" ? (
          <TerminalNotice kind="failed" message={turn.error ?? "Agent failed"} />
        ) : turn.status === "cancelled" ? (
          <TerminalNotice kind="cancelled" message="Interrupted" />
        ) : turn.status === "requires_action" ? (
          <TerminalNotice kind="waiting" message="Waiting for approval" />
        ) : (
          <PendingBubble />
        )}
      </div>
    </article>
  );
}

function ActivityMessage({ turn }: { turn: ConversationActivityTurn }) {
  return (
    <article className="message-in flex justify-start gap-2.5" data-testid="timeline-activity" data-activity-status={turn.status}>
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center">
        <span className="size-1.5 rounded-full bg-[color:var(--color-border-strong)]" />
      </div>
      <div className="min-w-0 max-w-[88%]">
        <TracePanel trace={turn.trace} status={turn.status} />
      </div>
    </article>
  );
}

function TracePanel(props: {
  trace: ConversationTraceItem[];
  status: ConversationActivityTurn["status"];
}) {
  const [open, setOpen] = useState(false);

  const failed = props.trace.some((item) => item.status === "failed");
  const running = props.trace.some((item) => item.status === "running");
  const summary = traceSummary(props.trace);

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 py-1 text-left text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
      >
        <span className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border",
          failed
            ? "border-red-400/35 bg-red-500/10 text-red-300"
            : running
              ? "border-amber-400/35 bg-amber-500/10 text-amber-300"
              : "border-emerald-400/35 bg-emerald-500/10 text-emerald-300",
        )}>
          {failed ? <AlertTriangleIcon className="size-3" /> : running ? <CircleDashedIcon className="size-3 animate-spin" /> : <CheckCircle2Icon className="size-3" />}
        </span>
        <span className="min-w-0 flex flex-1 items-baseline gap-2">
          <span className="shrink-0 text-xs font-medium text-[color:var(--color-fg)]">
            {running ? "Working" : failed ? "Action failed" : "Agent activity"}
          </span>
          <span className="truncate text-[11px] text-[color:var(--color-fg-subtle)]">{summary}</span>
        </span>
        <ChevronDownIcon className={cn("size-3.5 shrink-0 text-[color:var(--color-fg-subtle)] transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="mt-1.5 space-y-1.5 border-l border-[color:var(--color-border)] pl-3">
          {props.trace.map((item) => <TraceItemView key={item.id} item={item} />)}
        </div>
      ) : null}
    </div>
  );
}

function TraceItemView({ item }: { item: ConversationTraceItem }) {
  return (
    <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2">
      <div className="flex justify-center pt-0.5">
        <TraceIcon item={item} />
      </div>
      <div className="min-w-0 py-0.5">
        <div className="flex items-center justify-between gap-3">
          <div className="truncate text-xs font-medium text-[color:var(--color-fg)]">{item.title}</div>
          <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium", traceStatusClass(item.status))}>
            {traceStatusLabel(item.status)}
          </span>
        </div>
        {item.detail ? (
          <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-[color:var(--color-surface)]/70 p-2 text-[11px] leading-5 text-[color:var(--color-fg-muted)]">
            {item.detail}
          </pre>
        ) : null}
        {item.output ? (
          <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/45 p-2 text-[11px] leading-5 text-[color:var(--color-fg-muted)]">
            {item.output}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

function TraceIcon({ item }: { item: ConversationTraceItem }) {
  const iconClass = "size-3.5";
  const className = cn(
    "flex size-5 items-center justify-center rounded-full border",
    item.status === "failed"
      ? "border-red-400/35 bg-red-500/10 text-red-300"
      : item.status === "running"
        ? "border-amber-400/35 bg-amber-500/10 text-amber-300"
        : "border-[color:var(--color-border)] bg-[color:var(--color-surface)] text-[color:var(--color-fg-muted)]",
  );
  const icon =
    item.kind === "reasoning" ? <SparkleIcon className={iconClass} />
      : item.kind === "tool" ? <WrenchIcon className={iconClass} />
      : item.kind === "sandbox" ? <TerminalIcon className={iconClass} />
        : item.kind === "error" ? <AlertTriangleIcon className={iconClass} />
          : item.status === "complete" ? <CheckCircle2Icon className={iconClass} />
            : <CircleDashedIcon className={cn(iconClass, item.status === "running" && "animate-spin")} />;
  return <span className={className}>{icon}</span>;
}

function AvatarBubble({ variant }: { variant: "assistant" | "user" }) {
  return (
    <div className={cn(
      "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-surface)]",
      variant === "assistant" ? "text-[color:var(--color-brand)]" : "text-[color:var(--color-fg-muted)]",
    )}>
      {variant === "assistant" ? <BotIcon className="size-3.5" /> : <UserIcon className="size-3.5" />}
    </div>
  );
}

function MarkdownText({ text, compact = false, streaming = false }: { text: string; compact?: boolean; streaming?: boolean }) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      controls={{
        table: { copy: true, download: false, fullscreen: false },
        code: { copy: true, download: false },
        mermaid: false,
      }}
      components={markdownComponents}
      className={cn("markdown-stream", compact && "markdown-stream-compact")}
    >
      {text}
    </Streamdown>
  );
}

const markdownComponents: StreamdownComponents = {
  p: ({ className, ...props }) => <p className={cn("my-1.5 first:mt-0 last:mb-0", className)} {...props} />,
  h1: ({ className, ...props }) => <h1 className={cn("mb-2 mt-4 text-xl font-semibold leading-7 first:mt-0", className)} {...props} />,
  h2: ({ className, ...props }) => <h2 className={cn("mb-2 mt-4 text-lg font-semibold leading-7 first:mt-0", className)} {...props} />,
  h3: ({ className, ...props }) => <h3 className={cn("mb-1.5 mt-3 text-base font-semibold leading-6 first:mt-0", className)} {...props} />,
  h4: ({ className, ...props }) => <h4 className={cn("mb-1 mt-3 text-sm font-semibold leading-6 first:mt-0", className)} {...props} />,
  ul: ({ className, ...props }) => <ul className={cn("my-1.5 list-disc space-y-0.5 pl-5 first:mt-0 last:mb-0", className)} {...props} />,
  ol: ({ className, ...props }) => <ol className={cn("my-1.5 list-decimal space-y-0.5 pl-5 first:mt-0 last:mb-0", className)} {...props} />,
  li: ({ className, ...props }) => <li className={cn("pl-0.5", className)} {...props} />,
  blockquote: ({ className, ...props }) => (
    <blockquote className={cn("my-2 border-l-2 border-[color:var(--color-border-strong)] pl-3 text-[color:var(--color-fg-muted)]", className)} {...props} />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn("font-medium text-[color:var(--color-brand)] underline decoration-[color:var(--color-brand)]/40 underline-offset-2 hover:decoration-[color:var(--color-brand)]", className)}
      target="_blank"
      rel="noreferrer noopener"
      {...props}
    />
  ),
  inlineCode: ({ className, ...props }) => (
    <code className={cn("rounded bg-[color:var(--color-surface-2)] px-1 py-0.5 font-mono text-[0.86em] text-[color:var(--color-fg)]", className)} {...props} />
  ),
  pre: ({ className, ...props }) => (
    <pre className={cn("my-2 max-w-full overflow-x-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3 font-mono text-xs leading-5 text-[color:var(--color-fg-muted)] first:mt-0 last:mb-0", className)} {...props} />
  ),
  table: ({ className, ...props }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table className={cn("min-w-full border-collapse text-left text-xs", className)} {...props} />
    </div>
  ),
  thead: ({ className, ...props }) => <thead className={cn("border-b border-[color:var(--color-border)] text-[color:var(--color-fg)]", className)} {...props} />,
  tbody: ({ className, ...props }) => <tbody className={cn("divide-y divide-[color:var(--color-border)]/70", className)} {...props} />,
  th: ({ className, ...props }) => <th className={cn("whitespace-nowrap px-2 py-1.5 font-medium", className)} {...props} />,
  td: ({ className, ...props }) => <td className={cn("px-2 py-1.5 align-top text-[color:var(--color-fg-muted)]", className)} {...props} />,
  hr: ({ className, ...props }) => <hr className={cn("my-3 border-[color:var(--color-border)]", className)} {...props} />,
};

function PendingBubble() {
  return (
    <div
      aria-label="Agent is working"
      role="status"
      className="inline-flex h-8 items-center gap-1.5 rounded-2xl rounded-bl-sm border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3"
    >
      <PendingDot delay="0s" />
      <PendingDot delay="0.15s" />
      <PendingDot delay="0.3s" />
    </div>
  );
}

function PendingDot({ delay }: { delay: string }) {
  return (
    <span
      aria-hidden="true"
      className="pending-dot inline-block size-1.5 rounded-full bg-[color:var(--color-fg-muted)]"
      style={{ animationDelay: delay }}
    />
  );
}

function StreamingCursor() {
  return <span aria-hidden="true" className="ml-1 inline-block h-4 w-1 translate-y-0.5 animate-pulse rounded bg-[color:var(--color-brand)]" />;
}

function TerminalNotice({ kind, message }: { kind: "failed" | "cancelled" | "waiting"; message: string }) {
  const className = kind === "failed"
    ? "border-red-400/35 bg-red-500/10 text-red-200"
    : kind === "cancelled"
      ? "border-zinc-400/35 bg-zinc-500/10 text-zinc-200"
      : "border-amber-400/35 bg-amber-500/10 text-amber-200";
  return (
    <div className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs", className)}>
      {kind === "failed" ? <AlertTriangleIcon className="size-3.5" /> : <CircleDashedIcon className="size-3.5" />}
      <span>{message}</span>
    </div>
  );
}

function SessionInspector(props: {
  session: Session;
  events: SessionEvent[];
  connectionState: ConnectionState;
}) {
  const displayEvents = props.events.map(sanitizeEventForDisplay);
  const sortedEvents = [...displayEvents].sort((a, b) => b.sequence - a.sequence);
  const lifecycleEvents = [...displayEvents]
    .filter((event) => !event.type.endsWith(".delta"))
    .sort((a, b) => b.sequence - a.sequence);
  const repositories = props.session.resources.filter((resource) => resource.kind === "repository");

  return (
    <div className="flex h-full min-h-[28rem] w-full min-w-0 flex-col overflow-hidden">
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-[color:var(--color-border)] px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileJsonIcon className="size-4 shrink-0 text-[color:var(--color-brand)]" />
          <div className="min-w-0">
            <div className="text-sm font-medium">Debug</div>
            <div className="truncate text-xs text-[color:var(--color-fg-subtle)]">{props.events.length} events</div>
          </div>
        </div>
        <ConnectionPill state={props.connectionState} />
      </div>

      <Tabs defaultValue="overview" className="min-h-0 min-w-0 flex-1 gap-0 overflow-hidden">
        <div className="min-w-0 border-b border-[color:var(--color-border)] px-2 py-2">
          <TabsList className="grid h-8 w-full min-w-0 grid-cols-4 rounded-md bg-[color:var(--color-bg)] p-1">
            <TabsTrigger value="overview" className="h-6 min-w-0 rounded px-1 text-[11px]">Overview</TabsTrigger>
            <TabsTrigger value="events" className="h-6 min-w-0 rounded px-1 text-[11px]">Events</TabsTrigger>
            <TabsTrigger value="timeline" className="h-6 min-w-0 rounded px-1 text-[11px]">Timeline</TabsTrigger>
            <TabsTrigger value="raw" className="h-6 min-w-0 rounded px-1 text-[11px]">Raw</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="min-h-0 min-w-0 overflow-hidden">
          <ScrollArea className="h-full min-w-0">
            <div className="min-w-0 space-y-4 p-3">
              <InspectorSection title="Session">
                <InfoRow label="ID" value={<CopyableMono value={props.session.id} />} />
                <InfoRow label="Status" value={<StatusBadge status={props.session.status} />} />
                <InfoRow label="Workflow" value={props.session.temporalWorkflowId ? <CopyableMono value={props.session.temporalWorkflowId} /> : "none"} />
                <InfoRow label="Active turn" value={props.session.activeTurnId ? <CopyableMono value={props.session.activeTurnId} /> : "none"} />
                <InfoRow label="Last seq" value={String(props.session.lastSequence)} />
                <InfoRow label="Created" value={formatTimestamp(props.session.createdAt)} />
                <InfoRow label="Updated" value={formatTimestamp(props.session.updatedAt)} />
              </InspectorSection>

              <InspectorSection title="Runtime">
                <InfoRow label="Model" value={props.session.model} />
                <InfoRow label="Effort" value={String(props.session.metadata.reasoningEffort ?? "high")} />
                <InfoRow label="Sandbox" value={props.session.sandboxBackend} />
                <InfoRow label="Stream" value={<ConnectionPill state={props.connectionState} />} />
              </InspectorSection>

              <InspectorSection title="Repositories">
                {repositories.length === 0 ? (
                  <p className="text-xs text-[color:var(--color-fg-subtle)]">No repositories selected for this session.</p>
                ) : (
                  <div className="min-w-0 space-y-2">
                    {repositories.map((resource, index) => (
                      <div key={`${resource.uri}:${index}`} className="min-w-0 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/35 p-2">
                        <div className="min-w-0 truncate text-xs font-medium">{repositoryDisplayName(resource)}</div>
                        <div className="mt-1 min-w-0 truncate font-mono text-[11px] text-[color:var(--color-fg-subtle)]">{resource.uri}</div>
                        <div className="mt-2 flex min-w-0 flex-wrap gap-1.5 text-[11px] text-[color:var(--color-fg-subtle)]">
                          <span className="max-w-full truncate rounded border border-[color:var(--color-border)] px-1.5 py-0.5">ref {resource.ref}</span>
                          {resource.mountPath ? <span className="max-w-full truncate rounded border border-[color:var(--color-border)] px-1.5 py-0.5">{resource.mountPath}</span> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </InspectorSection>
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="events" className="min-h-0 min-w-0 overflow-hidden">
          <ScrollArea className="h-full min-w-0">
            <div className="min-w-0 space-y-2 p-3">
              {sortedEvents.map((event) => <EventDebugRow key={event.id} event={event} />)}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="timeline" className="min-h-0 min-w-0 overflow-hidden">
          <ScrollArea className="h-full min-w-0">
            <div className="min-w-0 space-y-2 p-3">
              {lifecycleEvents.map((event) => (
                <div key={event.id} className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/35 p-2">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-medium">{eventLabel(event.type)}</span>
                    <span className="shrink-0 font-mono text-[11px] text-[color:var(--color-fg-subtle)]">#{event.sequence}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-[color:var(--color-fg-subtle)]">{formatTimestamp(event.occurredAt)}</div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="raw" className="min-h-0 min-w-0 overflow-hidden">
          <RawJsonPane value={{ session: props.session, events: displayEvents }} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-[color:var(--color-fg-subtle)]">{title}</h3>
      <div className="min-w-0 overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-3">
        {children}
      </div>
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  const renderedValue = typeof value === "string" || typeof value === "number"
    ? <span className="min-w-0 truncate">{value}</span>
    : value;
  return (
    <div className="grid min-h-7 min-w-0 grid-cols-[5.25rem_minmax(0,1fr)] items-center gap-3 border-b border-[color:var(--color-border)]/70 py-1.5 last:border-b-0">
      <span className="min-w-0 truncate text-xs text-[color:var(--color-fg-subtle)]">{label}</span>
      <span className="flex min-w-0 justify-end overflow-hidden text-right text-xs text-[color:var(--color-fg-muted)]">{renderedValue}</span>
    </div>
  );
}

function CopyableMono({ value }: { value: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        toast.success("Copied");
      }}
      className="flex w-full min-w-0 max-w-full items-center justify-end gap-1 rounded px-1 py-0.5 font-mono text-[11px] text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-fg)]"
      title={value}
    >
      <span className="min-w-0 truncate text-right">{value}</span>
      <CopyIcon className="size-3 shrink-0" />
    </button>
  );
}

function EventDebugRow({ event }: { event: SessionEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0 overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/35">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full min-w-0 items-center justify-between gap-2 p-2 text-left">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">{eventLabel(event.type)}</div>
            <div className="mt-1 truncate font-mono text-[11px] text-[color:var(--color-fg-subtle)]">{event.turnId ?? event.id}</div>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-mono text-[11px] text-[color:var(--color-fg-muted)]">#{event.sequence}</div>
            <div className="mt-1 text-[11px] text-[color:var(--color-fg-subtle)]">{formatTimestamp(event.occurredAt)}</div>
          </div>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="max-h-72 max-w-full overflow-auto border-t border-[color:var(--color-border)] p-2 text-[11px] leading-5 text-[color:var(--color-fg-muted)]">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function sanitizeEventForDisplay(event: SessionEvent): SessionEvent {
  if (event.type !== "agent.reasoning.delta") {
    return event;
  }
  const text = reasoningSummaryText(event.payload);
  return {
    ...event,
    payload: { text: text || "Reasoning summary received." },
  };
}

function RawJsonPane({ value }: { value: unknown }) {
  const json = JSON.stringify(value, null, 2);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="flex items-center justify-end border-b border-[color:var(--color-border)] p-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            void navigator.clipboard.writeText(json);
            toast.success("Copied raw JSON");
          }}
        >
          <CopyIcon className="size-3" />
          Copy
        </Button>
      </div>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <pre className="max-w-full overflow-auto p-3 text-[11px] leading-5 text-[color:var(--color-fg-muted)]">{json}</pre>
      </ScrollArea>
    </div>
  );
}

function ConnectionPill({ state }: { state: ConnectionState }) {
  const tone = {
    connecting: "bg-amber-400",
    live: "bg-emerald-400",
    closed: "bg-zinc-500",
    error: "bg-red-400",
  }[state];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/60 px-2 py-1 text-xs font-medium text-[color:var(--color-fg-muted)]">
      <span className={cn("size-2 rounded-full", tone)} />
      <span>{state}</span>
    </span>
  );
}

function RecentSessions({ onSelect }: { onSelect: (id: string) => void }) {
  const sessions = recentSessions();
  if (sessions.length === 0) {
    return null;
  }
  return (
    <section className="mt-12">
      <h2 className="text-xs font-medium uppercase tracking-wider text-[color:var(--color-fg-subtle)]">Recent sessions</h2>
      <div className="mt-3 grid gap-2">
        {sessions.map((item) => (
          <button key={item.id} type="button" onClick={() => onSelect(item.id)} className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-3 text-left text-sm hover:bg-[color:var(--color-surface-2)]">
            <div className="truncate font-medium">{item.prompt}</div>
            <div className="mt-1 text-xs text-[color:var(--color-fg-subtle)]">{new Date(item.createdAt).toLocaleString()}</div>
          </button>
        ))}
      </div>
    </section>
  );
}

type ScheduledTaskFormState = {
  name: string;
  prompt: string;
  scheduleType: "once" | "interval" | "calendar";
  runAt: string;
  intervalMinutes: number;
  calendarTime: string;
  timeZone: string;
  runMode: ScheduledTask["runMode"];
  overlapPolicy: ScheduledTask["overlapPolicy"];
  includeOpenGeniTool: boolean;
  resources: ResourceRef[];
};

function newScheduledTaskFormState(includeOpenGeniTool: boolean, resources: ResourceRef[] = []): ScheduledTaskFormState {
  return {
    name: "",
    prompt: "",
    scheduleType: "once",
    runAt: localDateTimeValue(new Date(Date.now() + 60 * 60 * 1000)),
    intervalMinutes: 60,
    calendarTime: "09:00",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    includeOpenGeniTool,
    resources,
  };
}

export function formStateFromScheduledTask(task: ScheduledTask): ScheduledTaskFormState {
  const schedule = task.schedule;
  const base = newScheduledTaskFormState(
    task.agentConfig.tools.some((tool) => tool.kind === "mcp" && tool.id === "opengeni"),
    task.agentConfig.resources,
  );
  if (schedule.type === "interval") {
    base.scheduleType = "interval";
    base.intervalMinutes = Math.max(1, Math.round(schedule.everySeconds / 60));
  } else if (schedule.type === "calendar") {
    base.scheduleType = "calendar";
    base.calendarTime = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
    base.timeZone = schedule.timeZone;
  } else {
    base.scheduleType = "once";
    base.runAt = localDateTimeValue(new Date(schedule.runAt));
    base.timeZone = schedule.timeZone ?? base.timeZone;
  }
  return {
    ...base,
    name: task.name,
    prompt: task.agentConfig.prompt,
    runMode: task.runMode,
    overlapPolicy: task.overlapPolicy,
  };
}

export function scheduleFromFormState(form: ScheduledTaskFormState): ScheduledTaskScheduleSpec {
  return scheduledTaskSchedule(form.scheduleType, form.runAt, form.intervalMinutes, form.calendarTime, form.timeZone);
}

export function agentConfigFromFormState(
  form: ScheduledTaskFormState,
  existingTask?: ScheduledTask,
  defaults: { resources?: ResourceRef[]; model?: string; reasoningEffort?: ReasoningEffort } = {},
): ScheduledTaskAgentConfig {
  const tools = (existingTask?.agentConfig.tools ?? []).filter((tool) => !(tool.kind === "mcp" && tool.id === "opengeni"));
  if (form.includeOpenGeniTool) {
    tools.push({ kind: "mcp", id: "opengeni" });
  }
  return {
    prompt: form.prompt.trim(),
    resources: form.resources,
    tools,
    metadata: existingTask?.agentConfig.metadata ?? {},
    ...(existingTask?.agentConfig.model ?? defaults.model ? { model: existingTask?.agentConfig.model ?? defaults.model } : {}),
    ...(existingTask?.agentConfig.reasoningEffort ?? defaults.reasoningEffort ? { reasoningEffort: existingTask?.agentConfig.reasoningEffort ?? defaults.reasoningEffort } : {}),
    ...(existingTask?.agentConfig.sandboxBackend ? { sandboxBackend: existingTask.agentConfig.sandboxBackend } : {}),
  };
}

function ScheduledTasksPanel(props: {
  clientConfig: ClientConfig | null;
  resources: ResourceRef[];
  githubConfigured: boolean;
  githubRepos: GitHubRepository[];
  repositoryGroups: ReturnType<typeof groupRepositories>;
  repoBusy: boolean;
  onRefreshRepositories: () => Promise<void>;
  model: string;
  reasoningEffort: ReasoningEffort;
  onSelectSession: (id: string) => void;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [runs, setRuns] = useState<Record<string, ScheduledTaskRun[]>>({});
  const [open, setOpen] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const canAttachOpenGeniTool = props.clientConfig?.mcpServers.some((server) => server.id === "opengeni") !== false;

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    const next = await fetchScheduledTasks();
    setTasks(next);
    const entries = await Promise.all(next.slice(0, 8).map(async (task) => [task.id, await fetchScheduledTaskRuns(task.id)] as const));
    setRuns(Object.fromEntries(entries));
  }

  async function createTask(form: ScheduledTaskFormState) {
    if (!form.prompt.trim()) {
      toast.error("Scheduled task prompt is required");
      return;
    }
    setBusyTaskId("new");
    try {
      await createScheduledTask({
        name: form.name.trim() || form.prompt.trim().slice(0, 64),
        schedule: scheduleFromFormState(form),
        runMode: form.runMode,
        overlapPolicy: form.overlapPolicy,
        agentConfig: agentConfigFromFormState(form, undefined, {
          resources: props.resources,
          model: props.model,
          reasoningEffort: props.reasoningEffort,
        }),
      });
      setOpen(false);
      await refresh();
      toast.success("Scheduled task created");
    } catch (error) {
      toast.error("Failed to create scheduled task", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyTaskId(null);
    }
  }

  async function saveTask(task: ScheduledTask, form: ScheduledTaskFormState) {
    if (!form.prompt.trim()) {
      toast.error("Scheduled task prompt is required");
      return;
    }
    setBusyTaskId(task.id);
    try {
      await updateScheduledTask(task.id, {
        name: form.name.trim() || form.prompt.trim().slice(0, 64),
        schedule: scheduleFromFormState(form),
        runMode: form.runMode,
        overlapPolicy: form.overlapPolicy,
        agentConfig: agentConfigFromFormState(form, task),
      });
      setEditingTaskId(null);
      await refresh();
      toast.success("Scheduled task updated");
    } catch (error) {
      toast.error("Failed to update scheduled task", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyTaskId(null);
    }
  }

  async function taskAction(task: ScheduledTask, action: "pause" | "resume" | "trigger" | "delete") {
    setBusyTaskId(task.id);
    try {
      if (action === "pause") {
        await pauseScheduledTask(task.id);
      } else if (action === "resume") {
        await resumeScheduledTask(task.id);
      } else if (action === "trigger") {
        await triggerScheduledTask(task.id);
        toast.success("Scheduled task triggered");
      } else {
        await deleteScheduledTask(task.id);
        setEditingTaskId(null);
        toast.success("Scheduled task deleted");
      }
      await refresh();
    } catch (error) {
      toast.error("Scheduled task action failed", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyTaskId(null);
    }
  }

  return (
    <section className="mt-8 border-t border-[color:var(--color-border)] pt-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wider text-[color:var(--color-fg-subtle)]">Scheduled tasks</h2>
          <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">Create and manage recurring or one-shot agent runs.</p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()}>
            <RefreshCwIcon className="size-3.5" />
            Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setOpen((value) => !value);
              setEditingTaskId(null);
            }}
          >
            <CalendarClockIcon className="size-3.5" />
            New
          </Button>
        </div>
      </div>

      {open ? (
        <ScheduledTaskForm
          key="new"
          initialState={newScheduledTaskFormState(canAttachOpenGeniTool, props.resources)}
          submitLabel="Create scheduled task"
          busy={busyTaskId === "new"}
          canAttachOpenGeniTool={canAttachOpenGeniTool}
          githubConfigured={props.githubConfigured}
          githubRepos={props.githubRepos}
          repositoryGroups={props.repositoryGroups}
          repoBusy={props.repoBusy}
          onRefreshRepositories={props.onRefreshRepositories}
          onSubmit={createTask}
        />
      ) : null}

      <div className="mt-3 grid gap-2">
        {tasks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[color:var(--color-border)] p-4 text-sm text-[color:var(--color-fg-subtle)]">No scheduled tasks.</div>
        ) : tasks.map((task) => (
          <div key={task.id} className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{task.name}</div>
                <div className="mt-1 text-xs text-[color:var(--color-fg-subtle)]">{scheduleLabel(task.schedule)} · {task.runMode.replaceAll("_", " ")} · {task.status}</div>
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant={editingTaskId === task.id ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8"
                  onClick={() => {
                    setOpen(false);
                    setEditingTaskId((current) => current === task.id ? null : task.id);
                  }}
                >
                  <WrenchIcon className="size-3.5" />
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8"
                  disabled={busyTaskId === task.id}
                  onClick={() => void taskAction(task, task.status === "active" ? "pause" : "resume")}
                >
                  {task.status === "active" ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
                  {task.status === "active" ? "Pause" : "Resume"}
                </Button>
              </div>
            </div>
            {editingTaskId === task.id ? (
              <ScheduledTaskForm
                key={task.id}
                initialState={formStateFromScheduledTask(task)}
                submitLabel="Save changes"
                busy={busyTaskId === task.id}
                canAttachOpenGeniTool={canAttachOpenGeniTool}
                githubConfigured={props.githubConfigured}
                githubRepos={props.githubRepos}
                repositoryGroups={props.repositoryGroups}
                repoBusy={props.repoBusy}
                onRefreshRepositories={props.onRefreshRepositories}
                onSubmit={(form) => void saveTask(task, form)}
                onCancel={() => setEditingTaskId(null)}
                secondaryActions={(
                  <>
                    <Button type="button" variant="secondary" size="sm" disabled={busyTaskId === task.id} onClick={() => void taskAction(task, "trigger")}>
                      <BotIcon className="size-3.5" />
                      Run now
                    </Button>
                    <Button type="button" variant="destructive" size="sm" disabled={busyTaskId === task.id} onClick={() => void taskAction(task, "delete")}>
                      <Trash2Icon className="size-3.5" />
                      Delete
                    </Button>
                  </>
                )}
              />
            ) : null}
            {(runs[task.id] ?? []).length > 0 ? (
              <div className="mt-2 grid gap-1">
                {(runs[task.id] ?? []).slice(0, 3).map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    disabled={!run.sessionId}
                    onClick={() => run.sessionId ? props.onSelectSession(run.sessionId) : undefined}
                    className="flex items-center justify-between gap-2 rounded border border-[color:var(--color-border)] px-2 py-1.5 text-left text-xs text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-surface-2)] disabled:opacity-60"
                  >
                    <span>{run.triggerType} · {run.status}</span>
                    <span>{formatTimestamp(run.firedAt)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function ScheduledTaskForm(props: {
  initialState: ScheduledTaskFormState;
  submitLabel: string;
  busy: boolean;
  canAttachOpenGeniTool: boolean;
  githubConfigured: boolean;
  githubRepos: GitHubRepository[];
  repositoryGroups: ReturnType<typeof groupRepositories>;
  repoBusy: boolean;
  onRefreshRepositories: () => Promise<void>;
  onSubmit: (form: ScheduledTaskFormState) => void;
  onCancel?: () => void;
  secondaryActions?: ReactNode;
}) {
  const [form, setForm] = useState(props.initialState);
  const update = <K extends keyof ScheduledTaskFormState>(key: K, value: ScheduledTaskFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="mt-4 grid gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label>Name</Label>
          <Input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Daily infrastructure review" />
        </div>
        <div className="grid gap-1.5">
          <Label>Schedule</Label>
          <select
            className="h-9 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-sm"
            value={form.scheduleType}
            onChange={(event) => update("scheduleType", event.target.value as ScheduledTaskFormState["scheduleType"])}
          >
            <option value="once">Once</option>
            <option value="interval">Interval</option>
            <option value="calendar">Daily</option>
          </select>
        </div>
      </div>
      <textarea
        value={form.prompt}
        onChange={(event) => update("prompt", event.target.value)}
        className="min-h-20 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm"
        placeholder="What should the agent do on schedule?"
      />
      <div className="grid gap-2 sm:grid-cols-3">
        {form.scheduleType === "once" ? (
          <Input type="datetime-local" value={form.runAt} onChange={(event) => update("runAt", event.target.value)} />
        ) : form.scheduleType === "interval" ? (
          <Input type="number" min={1} value={form.intervalMinutes} onChange={(event) => update("intervalMinutes", Number(event.target.value))} />
        ) : (
          <Input type="time" value={form.calendarTime} onChange={(event) => update("calendarTime", event.target.value)} />
        )}
        <select
          className="h-9 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-sm"
          value={form.runMode}
          onChange={(event) => update("runMode", event.target.value as ScheduledTask["runMode"])}
        >
          <option value="new_session_per_run">New session per run</option>
          <option value="reusable_session">Reusable session</option>
        </select>
        <select
          className="h-9 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-sm"
          value={form.overlapPolicy}
          onChange={(event) => update("overlapPolicy", event.target.value as ScheduledTask["overlapPolicy"])}
        >
          <option value="allow_concurrent">Allow concurrent</option>
          <option value="skip">Skip overlapping</option>
          <option value="buffer_one">Buffer one</option>
        </select>
      </div>
      <label className="flex items-center gap-2 text-xs text-[color:var(--color-fg-muted)]">
        <input
          type="checkbox"
          checked={form.includeOpenGeniTool}
          disabled={!props.canAttachOpenGeniTool}
          onChange={(event) => update("includeOpenGeniTool", event.target.checked)}
        />
        Attach OpenGeni MCP tool
      </label>
      <ScheduledTaskRepositoryPicker
        configured={props.githubConfigured}
        repositories={props.githubRepos}
        groups={props.repositoryGroups}
        resources={form.resources}
        busy={props.busy}
        repoBusy={props.repoBusy}
        onRefresh={props.onRefreshRepositories}
        onResourcesChange={(resources) => update("resources", resources)}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {props.onCancel ? (
          <Button type="button" variant="ghost" size="sm" disabled={props.busy} onClick={props.onCancel}>
            Cancel
          </Button>
        ) : null}
        {props.secondaryActions}
        <Button type="button" onClick={() => props.onSubmit(form)} disabled={props.busy}>
          {props.busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
          {props.submitLabel}
        </Button>
      </div>
    </div>
  );
}

function ScheduledTaskRepositoryPicker(props: {
  configured: boolean;
  repositories: GitHubRepository[];
  groups: ReturnType<typeof groupRepositories>;
  resources: ResourceRef[];
  busy: boolean;
  repoBusy: boolean;
  onRefresh: () => Promise<void>;
  onResourcesChange: (resources: ResourceRef[]) => void;
}) {
  const repositoryResources = props.resources.filter((resource): resource is Extract<ResourceRef, { kind: "repository" }> => resource.kind === "repository");
  const fileResources = props.resources.filter((resource) => resource.kind === "file");
  const preservedRepositoryResources = repositoryResources.filter((resource) => !props.repositories.some((repo) => isRepositoryResourceForGitHubRepo(resource, repo)));
  const selectedInstallationId = repositoryResources.find((resource) => typeof resource.githubInstallationId === "number")?.githubInstallationId ?? null;

  function toggleRepo(repo: GitHubRepository) {
    const existing = props.resources.find((resource) => resource.kind === "repository" && isRepositoryResourceForGitHubRepo(resource, repo));
    if (existing) {
      props.onResourcesChange(props.resources.filter((resource) => resource !== existing));
      return;
    }
    if (selectedInstallationId !== null && selectedInstallationId !== repo.installationId) {
      toast.info("Scheduled tasks use one GitHub token", {
        description: "Clear selected repositories to choose repositories from another account.",
      });
      return;
    }
    try {
      const nextResource = gitHubRepositoryResource(repo, repo.defaultBranch);
      props.onResourcesChange([
        ...props.resources.filter((resource) => !sameRepositoryUri(resource, nextResource.uri)),
        nextResource,
      ]);
    } catch (error) {
      toast.error("Repository could not be selected", { description: error instanceof Error ? error.message : String(error) });
    }
  }

  function updateRef(repo: GitHubRepository, ref: string) {
    props.onResourcesChange(props.resources.map((resource) => {
      if (resource.kind !== "repository" || !isRepositoryResourceForGitHubRepo(resource, repo)) {
        return resource;
      }
      return { ...resource, ref };
    }));
  }

  return (
    <section className="overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/25">
      <div className="flex items-center justify-between gap-3 border-b border-[color:var(--color-border)] px-3 py-2">
        <div>
          <div className="text-xs font-medium text-[color:var(--color-fg)]">Repositories</div>
          <div className="mt-0.5 text-[11px] text-[color:var(--color-fg-subtle)]">{repoCountLabel(repositoryResources.length)} attached to this task</div>
        </div>
        <Button type="button" variant="ghost" size="xs" onClick={() => void props.onRefresh()} disabled={!props.configured || props.repoBusy || props.busy}>
          <RefreshCwIcon className={cn("size-3", props.repoBusy && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {!props.configured ? (
        <div className="p-3 text-xs leading-5 text-[color:var(--color-fg-muted)]">Configure the GitHub App to select repositories for scheduled runs.</div>
      ) : props.repoBusy ? (
        <div className="flex items-center gap-2 p-3 text-xs text-[color:var(--color-fg-muted)]">
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading repositories
        </div>
      ) : props.repositories.length === 0 ? (
        <div className="p-3 text-xs leading-5 text-[color:var(--color-fg-muted)]">No installed repositories found.</div>
      ) : (
        <div className="max-h-72 overflow-auto">
          {props.groups.map((group) => (
            <div key={group.installationId} className="border-b border-[color:var(--color-border)] last:border-b-0">
              <div className="flex items-center justify-between gap-3 bg-[color:var(--color-surface)]/45 px-3 py-1.5">
                <div className="min-w-0 truncate text-[11px] font-medium text-[color:var(--color-fg-muted)]">{group.label}</div>
                <div className="shrink-0 text-[10px] uppercase tracking-wide text-[color:var(--color-fg-subtle)]">{group.repositories.length} repos</div>
              </div>
              <div className="divide-y divide-[color:var(--color-border)]/70">
                {group.repositories.map((repo) => {
                  const resource = repositoryResources.find((item) => isRepositoryResourceForGitHubRepo(item, repo));
                  const checked = Boolean(resource);
                  const blocked = selectedInstallationId !== null && selectedInstallationId !== repo.installationId && !checked;
                  return (
                    <div key={`${repo.installationId}:${repo.id}`} className={cn("px-2 py-2 transition-colors hover:bg-[color:var(--color-surface-2)]/45", blocked && "opacity-55")}>
                      <button
                        type="button"
                        onClick={() => toggleRepo(repo)}
                        disabled={props.busy}
                        aria-pressed={checked}
                        aria-label={`Select ${repo.fullName} for scheduled task`}
                        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md text-left outline-none"
                      >
                        <span
                          className={cn(
                            "flex size-4 items-center justify-center rounded border",
                            checked
                              ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-strong)] text-[color:var(--color-brand-fg)]"
                              : "border-[color:var(--color-border-strong)] bg-[color:var(--color-surface)]",
                          )}
                        >
                          {checked ? <CheckIcon className="size-3" /> : null}
                        </span>
                        <span className="min-w-0">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-xs font-medium text-[color:var(--color-fg)]">{repo.fullName}</span>
                            {repo.private ? <LockIcon className="size-3 shrink-0 text-[color:var(--color-fg-subtle)]" /> : null}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-[color:var(--color-fg-subtle)]">default {repo.defaultBranch}</span>
                        </span>
                        {blocked ? (
                          <span className="rounded-full border border-amber-500/30 px-1.5 py-0.5 text-[10px] text-amber-200">other app</span>
                        ) : checked ? (
                          <span className="rounded-full border border-emerald-500/30 px-1.5 py-0.5 text-[10px] text-emerald-300">selected</span>
                        ) : null}
                      </button>
                      {resource ? (
                        <div className="mt-2 flex items-center gap-2 pl-6">
                          <GitBranchIcon className="size-3.5 shrink-0 text-[color:var(--color-fg-subtle)]" />
                          <Input
                            value={resource.ref}
                            onChange={(event) => updateRef(repo, event.target.value)}
                            onClick={(event) => event.stopPropagation()}
                            disabled={props.busy}
                            placeholder={repo.defaultBranch}
                            aria-label={`${repo.fullName} scheduled task ref`}
                            className="h-7 text-xs"
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {preservedRepositoryResources.length > 0 || fileResources.length > 0 ? (
        <div className="border-t border-[color:var(--color-border)] px-3 py-2 text-[11px] text-[color:var(--color-fg-subtle)]">
          Preserving {preservedRepositoryResources.length} manual repository resource{preservedRepositoryResources.length === 1 ? "" : "s"}
          {fileResources.length > 0 ? ` and ${fileResources.length} file resource${fileResources.length === 1 ? "" : "s"}` : ""}.
        </div>
      ) : null}
    </section>
  );
}

function useSessionStream(
  sessionId: string | null,
  after: number,
  accessKeyVersion: number,
  onEvents: (events: SessionEvent[]) => void,
  onState?: (state: ConnectionState) => void,
) {
  const onEventsRef = useRef(onEvents);
  onEventsRef.current = onEvents;
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  useEffect(() => {
    if (!sessionId) {
      onStateRef.current?.("closed");
      return;
    }
    const abort = new AbortController();
    void streamSessionEvents(sessionId, after, (event) => {
      onEventsRef.current([event]);
    }, {
      signal: abort.signal,
      onState: (state) => onStateRef.current?.(state),
    }).catch((error) => {
      if (!abort.signal.aborted) {
        onStateRef.current?.("error");
        toast.error("Event stream disconnected", { description: error instanceof Error ? error.message : String(error) });
      }
    });
    return () => {
      abort.abort();
      onStateRef.current?.("closed");
    };
  }, [sessionId, accessKeyVersion]);
}

type CapabilityFormState = {
  kind: Exclude<CapabilityKind, "pack">;
  name: string;
  description: string;
  category: string;
  tags: string;
  endpointUrl: string;
  homepageUrl: string;
  installUrl: string;
  enableAfterAdd: boolean;
};

function emptyCapabilityForm(): CapabilityFormState {
  return {
    kind: "mcp",
    name: "",
    description: "",
    category: "custom",
    tags: "",
    endpointUrl: "",
    homepageUrl: "",
    installUrl: "",
    enableAfterAdd: true,
  };
}

export function filterCapabilityCatalogItems(items: CapabilityCatalogItem[], filter: CapabilityFilter, query: string): CapabilityCatalogItem[] {
  const normalized = query.trim().toLowerCase();
  return items.filter((item) => {
    if (filter !== "all" && item.kind !== filter) {
      return false;
    }
    if (!normalized) {
      return true;
    }
    return [
      item.name,
      item.description,
      item.kind,
      item.source,
      item.category,
      item.endpointUrl,
      item.homepageUrl,
      item.installUrl,
      ...item.tags,
      JSON.stringify(item.metadata),
    ].filter(Boolean).join(" ").toLowerCase().includes(normalized);
  });
}

export function capabilityErrorToast(error: unknown, fallbackTitle: string): { title: string; description: string } {
  const description = cleanApiErrorMessage(error instanceof Error ? error.message : String(error));
  if (/^MCP capability ".+" could not be enabled because OpenGeni could not initialize /.test(description)) {
    return { title: "MCP connection failed", description };
  }
  return { title: fallbackTitle, description };
}

function cleanApiErrorMessage(message: string): string {
  return message.replace(/^API\s+\d+:\s*/i, "").trim();
}

type PackConnectorSummary = {
  id: string;
  name: string;
  authModel: string | null;
  providers: string[];
  scopes: string[];
  required: boolean;
};

type PackKnowledgeSummary = {
  id: string;
  name: string;
  description: string | null;
};

type PackScheduledTaskTemplateSummary = {
  id: string;
  name: string;
  scheduleSummary: string;
};

type PackContentsSummary = {
  hasContents: boolean;
  mcpServerIds: string[];
  firstPartyMcpTools: string[];
  skills: string[];
  connectors: PackConnectorSummary[];
  knowledge: PackKnowledgeSummary[];
  scheduledTaskTemplates: PackScheduledTaskTemplateSummary[];
};

export function summarizePackContents(item: CapabilityCatalogItem): PackContentsSummary | null {
  if (item.kind !== "pack") {
    return null;
  }
  const metadata = item.metadata;
  const mcpServerIds = uniqueStrings(item.tools.filter((tool) => tool.kind === "mcp").map((tool) => tool.id));
  const firstPartyMcpTools = uniqueStrings(stringArray(metadata.firstPartyMcpTools));
  const skills = uniqueStrings([
    stringValue(metadata.skill),
    ...stringArray(metadata.skills),
  ]);
  const connectors = recordArray(metadata.connectors).map((connector) => ({
    id: stringValue(connector.id) ?? stringValue(connector.name) ?? "connector",
    name: stringValue(connector.name) ?? stringValue(connector.id) ?? "Connector",
    authModel: stringValue(connector.authModel),
    providers: stringArray(connector.providers),
    scopes: stringArray(connector.scopes),
    required: connector.required === true,
  }));
  const knowledge = recordArray(metadata.knowledge).map((entry) => ({
    id: stringValue(entry.id) ?? stringValue(entry.name) ?? "knowledge",
    name: stringValue(entry.name) ?? stringValue(entry.id) ?? "Knowledge",
    description: stringValue(entry.description),
  }));
  const scheduledTaskTemplates = recordArray(metadata.scheduledTaskTemplates).map((template) => ({
    id: stringValue(template.id) ?? stringValue(template.name) ?? "schedule",
    name: stringValue(template.name) ?? stringValue(template.id) ?? "Scheduled task",
    scheduleSummary: scheduleSummaryForMetadata(template.defaultSchedule),
  }));
  return {
    hasContents: mcpServerIds.length > 0
      || firstPartyMcpTools.length > 0
      || skills.length > 0
      || connectors.length > 0
      || knowledge.length > 0
      || scheduledTaskTemplates.length > 0,
    mcpServerIds,
    firstPartyMcpTools,
    skills,
    connectors,
    knowledge,
    scheduledTaskTemplates,
  };
}

function scheduleSummaryForMetadata(value: unknown): string {
  const schedule = recordValue(value);
  if (!schedule) {
    return "Custom schedule";
  }
  const type = stringValue(schedule.type);
  if (type === "calendar") {
    const hour = numberValue(schedule.hour);
    const minute = numberValue(schedule.minute);
    const timeZone = stringValue(schedule.timeZone) ?? "UTC";
    if (hour !== null && minute !== null) {
      return `Calendar at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${timeZone}`;
    }
    return `Calendar schedule in ${timeZone}`;
  }
  if (type === "interval") {
    const everySeconds = numberValue(schedule.everySeconds);
    return everySeconds ? `Every ${everySeconds} seconds` : "Interval schedule";
  }
  if (type === "once") {
    return stringValue(schedule.runAt) ? `Once at ${stringValue(schedule.runAt)}` : "One-time schedule";
  }
  return type ? `${type} schedule` : "Custom schedule";
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordValue).filter((entry): entry is Record<string, unknown> => Boolean(entry)) : [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).filter((entry): entry is string => Boolean(entry)) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function capabilityCounts(items: CapabilityCatalogItem[]): Record<CapabilityFilter, number> {
  return {
    all: items.length,
    pack: items.filter((item) => item.kind === "pack").length,
    mcp: items.filter((item) => item.kind === "mcp").length,
    api: items.filter((item) => item.kind === "api").length,
    skill: items.filter((item) => item.kind === "skill").length,
    plugin: items.filter((item) => item.kind === "plugin").length,
  };
}

function capabilityFilterLabel(kind: CapabilityFilter): string {
  return kind === "all" ? "All" : kind === "mcp" ? "MCPs" : `${kind[0]!.toUpperCase()}${kind.slice(1)}s`;
}

function capabilityKindIcon(kind: CapabilityFilter): ReactNode {
  const className = "size-3.5";
  if (kind === "pack") return <PackageIcon className={className} />;
  if (kind === "mcp") return <PlugIcon className={className} />;
  if (kind === "api") return <GlobeIcon className={className} />;
  if (kind === "skill") return <SparkleIcon className={className} />;
  if (kind === "plugin") return <WrenchIcon className={className} />;
  return <FilesIcon className={className} />;
}

function createInputFromCatalogItem(item: CapabilityCatalogItem): CreateCapabilityInput {
  return {
    id: item.id,
    kind: item.kind as Exclude<CapabilityKind, "pack">,
    source: item.source,
    name: item.name,
    ...(item.description ? { description: item.description } : {}),
    category: item.category,
    tags: item.tags,
    ...(item.homepageUrl ? { homepageUrl: item.homepageUrl } : {}),
    ...(item.endpointUrl ? { endpointUrl: item.endpointUrl } : {}),
    ...(item.installUrl ? { installUrl: item.installUrl } : {}),
    ...(item.authModel ? { authModel: item.authModel } : {}),
    metadata: item.metadata,
  };
}

function capabilityInputFromForm(form: CapabilityFormState): CreateCapabilityInput | null {
  const name = form.name.trim();
  if (!name) {
    return null;
  }
  return {
    kind: form.kind,
    source: "manual",
    name,
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    category: form.category.trim() || "custom",
    tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    ...(form.endpointUrl.trim() ? { endpointUrl: form.endpointUrl.trim() } : {}),
    ...(form.homepageUrl.trim() ? { homepageUrl: form.homepageUrl.trim() } : {}),
    ...(form.installUrl.trim() ? { installUrl: form.installUrl.trim() } : {}),
  };
}

function enabledCustomMcpServers(config: ClientConfig | null): Array<{ id: string; name: string }> {
  if (!config) {
    return [];
  }
  const builtIns = new Set(["opengeni", "docs", "files"]);
  return config.mcpServers.filter((server) => !builtIns.has(server.id));
}

export function selectedAvailableCapabilityToolIds(current: Set<string>, availableIds: string[], previouslyAvailableIds: Set<string> = new Set()): Set<string> {
  const available = new Set(availableIds);
  const next = new Set([...current].filter((id) => available.has(id)));
  for (const id of availableIds) {
    if (id && !previouslyAvailableIds.has(id)) {
      next.add(id);
    }
  }
  return next;
}

function buildResources(manualRepos: RepoDraft[], repos: GitHubRepository[], selected: Set<number>, selectedRefs: Record<number, string>): ResourceRef[] {
  const raw = [
    ...repos.filter((repo) => selected.has(repo.id)).map((repo) => ({
      url: repo.cloneUrl,
      ref: (selectedRefs[repo.id] ?? repo.defaultBranch).trim(),
      repositoryId: repo.id,
      installationId: repo.installationId,
    })),
    ...manualRepos.map((repo) => ({
      url: repo.url.trim(),
      ref: repo.ref.trim(),
      repositoryId: null,
      installationId: null,
    })),
  ].filter((repo) => repo.url.length > 0);
  const mountPaths = new Set<string>();
  return raw.map((repo) => {
    if (!repo.ref) {
      throw new Error("Repository ref is required.");
    }
    const parsed = normalizeRepositoryUrl(repo.url);
    const mountPath = `repos/${parsed.repo}`;
    if (mountPaths.has(mountPath)) {
      throw new Error(`Duplicate repository mount path: ${mountPath}`);
    }
    mountPaths.add(mountPath);
    return {
      kind: "repository",
      uri: `https://${parsed.host}/${parsed.repo}.git`,
      ref: repo.ref,
      mountPath,
      ...(repo.repositoryId ? { githubRepositoryId: repo.repositoryId } : {}),
      ...(repo.installationId ? { githubInstallationId: repo.installationId } : {}),
    };
  });
}

function gitHubRepositoryResource(repo: GitHubRepository, ref: string): Extract<ResourceRef, { kind: "repository" }> {
  const parsed = normalizeRepositoryUrl(repo.cloneUrl);
  return {
    kind: "repository",
    uri: `https://${parsed.host}/${parsed.repo}.git`,
    ref: ref.trim() || repo.defaultBranch,
    mountPath: `repos/${parsed.repo}`,
    githubRepositoryId: repo.id,
    githubInstallationId: repo.installationId,
  };
}

function isRepositoryResourceForGitHubRepo(resource: Extract<ResourceRef, { kind: "repository" }>, repo: GitHubRepository): boolean {
  return resource.githubRepositoryId === repo.id && resource.githubInstallationId === repo.installationId;
}

function sameRepositoryUri(resource: ResourceRef, uri: string): boolean {
  return resource.kind === "repository" && resource.uri === uri;
}

export function buildTools(existing: ToolRef[] | undefined, documentSearchEnabled: boolean, openGeniEnabled: boolean, extraMcpServerIds: string[] = []): ToolRef[] {
  const out = [...(existing ?? [])];
  if (openGeniEnabled && !out.some((tool) => tool.kind === "mcp" && tool.id === "opengeni")) {
    out.push({ kind: "mcp", id: "opengeni" });
  }
  for (const id of extraMcpServerIds) {
    if (id && !out.some((tool) => tool.kind === "mcp" && tool.id === id)) {
      out.push({ kind: "mcp", id });
    }
  }
  if (documentSearchEnabled) {
    for (const id of ["docs", "files"]) {
      if (!out.some((tool) => tool.kind === "mcp" && tool.id === id)) {
        out.push({ kind: "mcp", id });
      }
    }
  }
  return out;
}

function isResourceRefArray(value: unknown): value is ResourceRef[] {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const resource = item as Partial<ResourceRef>;
    if (resource.kind === "file") {
      return typeof resource.fileId === "string";
    }
    if (resource.kind === "repository") {
      return typeof resource.uri === "string" && typeof resource.ref === "string";
    }
    return false;
  });
}

function isToolRefArray(value: unknown): value is ToolRef[] {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const tool = item as Partial<ToolRef>;
    return tool.kind === "mcp" && typeof tool.id === "string";
  });
}

function repositoryDisplayName(resource: Extract<ResourceRef, { kind: "repository" }>): string {
  try {
    return new URL(resource.uri).pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  } catch {
    return resource.uri;
  }
}

function normalizeRepositoryUrl(value: string): { host: string; repo: string } {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (url.protocol !== "https:") {
    throw new Error("Repository URL must use HTTPS.");
  }
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Repository URL must include owner and repo.");
  }
  return { host: url.hostname.toLowerCase(), repo: parts.join("/") };
}

export function projectConversation(session: Session, events: SessionEvent[]): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  let currentMessage: ConversationAssistantTurn | null = null;
  let currentActivity: ConversationActivityTurn | null = null;

  const lastMessage = (): ConversationAssistantTurn | null => {
    const item = out[out.length - 1];
    return item?.kind === "assistant" ? item : null;
  };

  const lastActivity = (): ConversationActivityTurn | null => {
    const item = out[out.length - 1];
    return item?.kind === "activity" ? item : null;
  };

  const startMessage = (event: SessionEvent): ConversationAssistantTurn => {
    const existing = lastMessage();
    if (existing) {
      currentMessage = existing;
      return existing;
    }
    const activity = lastActivity();
    if (activity?.status === "running") {
      activity.status = "complete";
      completeRunningActivity(activity);
    }
    currentActivity = null;
    currentMessage = {
      kind: "assistant",
      id: `assistant-message-${event.id}`,
      turnId: event.turnId ?? null,
      text: "",
      status: "running",
      occurredAt: event.occurredAt,
    };
    out.push(currentMessage);
    return currentMessage;
  };

  const startActivity = (event: SessionEvent): ConversationActivityTurn => {
    const existing = lastActivity();
    if (existing) {
      currentActivity = existing;
      return existing;
    }
    const message = lastMessage();
    if (message?.status === "running") {
      message.status = "complete";
    }
    currentMessage = null;
    currentActivity = {
      kind: "activity",
      id: `activity-${event.id}`,
      turnId: event.turnId ?? null,
      status: "running",
      trace: [],
      occurredAt: event.occurredAt,
    };
    out.push(currentActivity);
    return currentActivity;
  };

  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const payload = event.payload as Record<string, unknown>;
    if (event.type === "user.message") {
      currentMessage = null;
      currentActivity = null;
      out.push({
        kind: "user",
        id: event.id,
        text: String(payload.text ?? ""),
        resources: isResourceRefArray(payload.resources) ? payload.resources : [],
        tools: isToolRefArray(payload.tools) ? payload.tools : [],
        occurredAt: event.occurredAt,
      });
    } else if (event.type === "agent.message.delta") {
      const text = String(payload.text ?? "");
      if (!text) {
        continue;
      }
      const assistant = startMessage(event);
      assistant.status = "running";
      assistant.text += text;
    } else if (event.type === "agent.message.completed") {
      const text = String(payload.text ?? "");
      const assistant = lastMessage() ?? startMessage(event);
      if (!assistant.text || text.startsWith(assistant.text)) {
        assistant.text = text || assistant.text;
      }
      assistant.status = "complete";
      currentMessage = null;
    } else if (event.type === "agent.reasoning.delta") {
      const text = reasoningSummaryText(payload) || "Reasoning summary received.";
      const activity = startActivity(event);
      activity.status = "running";
      const existing = findTrace(activity, `reasoning:${activity.id}`, "reasoning");
      if (existing) {
        existing.status = "running";
        existing.detail = existing.detail ? `${existing.detail}${text}` : text;
      } else {
        activity.trace.push({
          id: event.id,
          key: `reasoning:${activity.id}`,
          kind: "reasoning",
          status: "running",
          title: "Reasoning summary",
          detail: text,
          occurredAt: event.occurredAt,
        });
      }
    } else if (event.type === "agent.toolCall.created") {
      const activity = startActivity(event);
      activity.status = "running";
      activity.trace.push({
        id: event.id,
        key: traceKey(event),
        kind: "tool",
        status: "running",
        title: toolTitle(payload),
        detail: prettyJson(payload.arguments ?? payload.raw ?? payload),
        occurredAt: event.occurredAt,
      });
    } else if (event.type === "agent.toolCall.output") {
      const activity = startActivity(event);
      const key = traceKey(event);
      const existing = findTrace(activity, key, "tool");
      const output = stringifyPayload(payload.output ?? payload);
      if (existing) {
        existing.status = "complete";
        existing.output = output;
      } else {
        activity.trace.push({
          id: event.id,
          key,
          kind: "tool",
          status: "complete",
          title: "Tool output",
          output,
          occurredAt: event.occurredAt,
        });
      }
    } else if (event.type === "sandbox.operation.started" || event.type === "sandbox.operation.completed" || event.type === "sandbox.operation.failed") {
      const activity = startActivity(event);
      const key = `sandbox:${String(payload.name ?? event.id)}`;
      const existing = findTrace(activity, key, "sandbox");
      const status = event.type.endsWith(".failed") ? "failed" : event.type.endsWith(".completed") ? "complete" : "running";
      if (existing) {
        existing.status = status;
        if (payload.error) {
          existing.output = String(payload.error);
        }
      } else {
        activity.trace.push({
          id: event.id,
          key,
          kind: "sandbox",
          status,
          title: sandboxTitle(payload),
          detail: typeof payload.command === "string" ? payload.command : undefined,
          output: payload.error ? String(payload.error) : undefined,
          occurredAt: event.occurredAt,
        });
      }
      activity.status = status === "failed" ? "failed" : status === "complete" ? "complete" : "running";
    } else if (event.type === "session.requiresAction") {
      const activity = startActivity(event);
      activity.status = "requires_action";
      activity.trace.push({
        id: event.id,
        key: event.id,
        kind: "approval",
        status: "waiting",
        title: "Approval required",
        detail: prettyJson(payload.approvals ?? payload),
        occurredAt: event.occurredAt,
      });
    } else if (event.type === "turn.failed") {
      const activity = startActivity(event);
      activity.status = "failed";
      completeRunningActivity(activity);
      activity.trace.push({
        id: event.id,
        key: event.id,
        kind: "error",
        status: "failed",
        title: "Turn failed",
        output: String(payload.error ?? "Unknown error"),
        occurredAt: event.occurredAt,
      });
    } else if (event.type === "turn.cancelled") {
      const message = lastMessage();
      if (message) {
        message.status = "cancelled";
      } else {
        const activity = startActivity(event);
        activity.status = "cancelled";
        completeRunningActivity(activity);
      }
    } else if (event.type === "turn.started") {
      currentMessage = null;
      currentActivity = null;
    } else if (event.type === "turn.completed") {
      const message = lastMessage();
      if (message) {
        if (!message.text && typeof payload.output === "string") {
          message.text = payload.output;
        }
        message.status = "complete";
        currentMessage = null;
      }
      for (const activity of out) {
        if (activity.kind !== "activity" || activity.status !== "running") {
          continue;
        }
        if (event.turnId && activity.turnId && activity.turnId !== event.turnId) {
          continue;
        }
        activity.status = "complete";
        completeRunningActivity(activity);
      }
      currentActivity = null;
    }
  }
  if (out.length === 0 && session.initialMessage) {
    out.push({
      kind: "user",
      id: `user-${session.id}`,
      text: session.initialMessage,
      resources: session.resources,
      tools: session.tools,
      occurredAt: session.createdAt,
    });
  }
  return out;
}

function completeRunningActivity(activity: ConversationActivityTurn): void {
  for (const item of activity.trace) {
    if (item.status === "running") {
      item.status = "complete";
    }
  }
}

function findTrace(activity: ConversationActivityTurn, key: string, kind: ConversationTraceKind): ConversationTraceItem | undefined {
  const trace = [...activity.trace].reverse();
  return trace.find((item) => item.key === key)
    ?? trace.find((item) => item.kind === kind && item.status === "running");
}

function reasoningSummaryText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const directText = (payload as { text?: unknown }).text;
  if (typeof directText === "string") {
    return directText;
  }
  const item = (payload as { item?: unknown }).item;
  const rawItem = item && typeof item === "object" ? (item as { rawItem?: unknown }).rawItem : undefined;
  const content = rawItem && typeof rawItem === "object" ? (rawItem as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")
    .filter(Boolean)
    .join("");
}

function traceKey(event: SessionEvent): string {
  const payload = event.payload as Record<string, unknown>;
  return String(payload.id ?? payload.callId ?? event.turnId ?? event.id);
}

function toolTitle(payload: Record<string, unknown>): string {
  const name = String(payload.name ?? "tool");
  if (name === "shell_call" || name.includes("shell")) {
    return "Shell command";
  }
  return `Tool: ${name}`;
}

function sandboxTitle(payload: Record<string, unknown>): string {
  const name = String(payload.name ?? "sandbox");
  return name === "azure-cli-login" ? "Azure CLI login" : `Sandbox: ${name}`;
}

function prettyJson(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function stringifyPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function approvalItems(payload: unknown): Array<{ id: string; name: string; arguments?: unknown; raw?: unknown }> {
  const approvals = (payload as { approvals?: unknown }).approvals;
  if (!Array.isArray(approvals)) {
    return [];
  }
  return approvals.map((approval, index) => {
    const raw = approval as Record<string, unknown>;
    const rawItem = raw.rawItem && typeof raw.rawItem === "object" ? raw.rawItem as Record<string, unknown> : {};
    return {
      id: String(raw.id ?? raw.callId ?? rawItem.callId ?? index),
      name: String(raw.name ?? "approval"),
      arguments: raw.arguments,
      raw,
    };
  });
}

function groupRepositories(repositories: GitHubRepository[]) {
  return repositories.reduce<Array<{ installationId: number; label: string; detail: string; repositories: GitHubRepository[] }>>((groups, repo) => {
    let group = groups.find((item) => item.installationId === repo.installationId);
    if (!group) {
      group = {
        installationId: repo.installationId,
        label: repo.accountLogin,
        detail: repo.accountType ?? "GitHub account",
        repositories: [],
      };
      groups.push(group);
    }
    group.repositories.push(repo);
    return groups;
  }, []);
}

function repoCountLabel(count: number): string {
  return `${count} ${count === 1 ? "repo" : "repos"}`;
}

function mergeEvents(current: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) {
    byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

function sessionIdFromPath(): string | null {
  const match = window.location.pathname.match(/^\/sessions\/([0-9a-f-]+)/i);
  return match?.[1] ?? null;
}

function statusTone(status: SessionStatus): string {
  if (status === "running" || status === "queued") return "bg-[color:var(--color-status-running)]";
  if (status === "idle") return "bg-[color:var(--color-status-success)]";
  if (status === "failed") return "bg-[color:var(--color-status-failed)]";
  if (status === "cancelled") return "bg-[color:var(--color-status-cancelled)]";
  return "bg-[color:var(--color-status-waiting)]";
}

function traceSummary(trace: ConversationTraceItem[]): string {
  const counts = trace.reduce<Record<ConversationTraceKind, number>>((acc, item) => {
    acc[item.kind] = (acc[item.kind] ?? 0) + 1;
    return acc;
  }, {} as Record<ConversationTraceKind, number>);
  const parts = [
    counts.reasoning ? "reasoning" : "",
    counts.tool ? `${counts.tool} tools` : "",
    counts.sandbox ? `${counts.sandbox} sandbox` : "",
    counts.approval ? `${counts.approval} approvals` : "",
    counts.error ? `${counts.error} errors` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : `${trace.length} events`;
}

function traceStatusClass(status: ConversationTraceStatus): string {
  if (status === "running") return "bg-amber-500/10 text-amber-200";
  if (status === "failed") return "bg-red-500/10 text-red-200";
  if (status === "waiting") return "bg-blue-500/10 text-blue-200";
  return "bg-emerald-500/10 text-emerald-200";
}

function traceStatusLabel(status: ConversationTraceStatus): string {
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  if (status === "waiting") return "waiting";
  return "done";
}

function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    "session.created": "Session created",
    "session.status.changed": "Status changed",
    "session.requiresAction": "Approval required",
    "user.message": "User message",
    "user.interrupt": "User interrupt",
    "user.approvalDecision": "Approval decision",
    "turn.started": "Turn started",
    "turn.completed": "Turn completed",
    "turn.failed": "Turn failed",
    "turn.cancelled": "Turn cancelled",
    "agent.message.delta": "Assistant delta",
    "agent.message.completed": "Assistant completed",
    "agent.reasoning.delta": "Model activity",
    "agent.toolCall.created": "Tool call",
    "agent.toolCall.output": "Tool output",
    "agent.updated": "Agent updated",
    "sandbox.operation.started": "Sandbox operation started",
    "sandbox.operation.completed": "Sandbox operation completed",
    "sandbox.operation.failed": "Sandbox operation failed",
    "sandbox.command.output.delta": "Sandbox output",
    "artifact.created": "Artifact created",
  };
  return labels[type] ?? type;
}

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

function localDateTimeValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function scheduledTaskSchedule(type: "once" | "interval" | "calendar", runAt: string, intervalMinutes: number, calendarTime: string, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"): ScheduledTaskScheduleSpec {
  if (type === "interval") {
    return { type: "interval", everySeconds: Math.max(60, Math.round(intervalMinutes * 60)) };
  }
  if (type === "calendar") {
    const [hourRaw, minuteRaw] = calendarTime.split(":");
    return {
      type: "calendar",
      timeZone,
      hour: Number(hourRaw ?? 9),
      minute: Number(minuteRaw ?? 0),
    };
  }
  return {
    type: "once",
    runAt: new Date(runAt).toISOString(),
    timeZone,
  };
}

function scheduleLabel(schedule: ScheduledTaskScheduleSpec): string {
  if (schedule.type === "interval") {
    return `Every ${Math.round(schedule.everySeconds / 60)} min`;
  }
  if (schedule.type === "calendar") {
    return `Daily ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")} ${schedule.timeZone}`;
  }
  return `Once ${formatTimestamp(schedule.runAt)}`;
}

function isUiReasoningEffort(value: ReasoningEffort): value is IntelligenceEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function labelEffort(value: IntelligenceEffort): string {
  return value === "xhigh" ? "Extra high" : value.slice(0, 1).toUpperCase() + value.slice(1);
}

function displayModel(value: string): string {
  return value.startsWith("gpt-") ? value.replace("gpt-", "").toUpperCase() : value;
}

function rememberSession(session: Session) {
  const items = [{ id: session.id, prompt: session.initialMessage, createdAt: session.createdAt }, ...recentSessions().filter((item) => item.id !== session.id)].slice(0, 8);
  localStorage.setItem("opengeni-recent-sessions", JSON.stringify(items));
}

function recentSessions(): Array<{ id: string; prompt: string; createdAt: string }> {
  try {
    const parsed = JSON.parse(localStorage.getItem("opengeni-recent-sessions") ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => item?.id && item?.prompt && item?.createdAt) : [];
  } catch {
    return [];
  }
}
