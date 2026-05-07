import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  BotIcon,
  CheckIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDashedIcon,
  CopyIcon,
  FileJsonIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  Loader2Icon,
  LockIcon,
  PanelRightIcon,
  PlusIcon,
  RefreshCwIcon,
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
  createSession,
  fetchClientConfig,
  fetchEvents,
  fetchGitHubRepositories,
  fetchGitHubStatus,
  fetchSession,
  sendApproval,
  sendInterrupt,
  sendUserMessage,
  startGitHubManifest,
  streamUrl,
} from "./api";
import type {
  ClientConfig,
  GitHubRepository,
  ReasoningEffort,
  ResourceRef,
  Session,
  SessionEvent,
  SessionStatus,
} from "./types";
import { cn } from "@/lib/utils";

const streamEventTypes = [
  "session.created",
  "session.status.changed",
  "session.requiresAction",
  "user.message",
  "user.interrupt",
  "user.approvalDecision",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "agent.message.delta",
  "agent.message.completed",
  "agent.reasoning.delta",
  "agent.toolCall.created",
  "agent.toolCall.output",
  "agent.updated",
  "sandbox.operation.started",
  "sandbox.operation.completed",
  "sandbox.operation.failed",
  "sandbox.command.output.delta",
  "artifact.created",
];

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
  const [busy, setBusy] = useState(false);
  const [repoBusy, setRepoBusy] = useState(false);
  const [githubAppBusy, setGithubAppBusy] = useState(false);
  const lastSequence = useMemo(() => events.reduce((max, event) => Math.max(max, event.sequence), 0), [events]);

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
    void refreshGitHub();
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      setEvents([]);
      setConnectionState("closed");
      return;
    }
    void fetchSession(sessionId).then(setSession).catch((error) => toast.error("Failed to load session", { description: String(error) }));
    void fetchEvents(sessionId).then(setEvents).catch((error) => toast.error("Failed to load events", { description: String(error) }));
  }, [sessionId]);

  useSessionStream(sessionId, lastSequence, (incoming) => {
    setEvents((current) => mergeEvents(current, incoming));
    if (incoming.some((event) => event.type === "session.status.changed")) {
      void fetchSession(incoming[0]!.sessionId).then(setSession).catch(() => undefined);
    }
  }, setConnectionState);

  const selectedInstalledRepositories = githubRepos.filter((repo) => selectedRepoIds.has(repo.id));
  const selectedInstallationId = selectedInstalledRepositories[0]?.installationId ?? null;
  const repositoryGroups = useMemo(() => groupRepositories(githubRepos), [githubRepos]);
  const conversation = useMemo(() => session ? projectConversation(session, events) : [], [session, events]);
  const approvals = events.flatMap((event) => event.type === "session.requiresAction" ? approvalItems(event.payload) : []);
  const canSendFollowUp = session?.status === "idle";
  const sessionRunning = session?.status === "running" || session?.status === "queued";

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

  async function submitInitial(prompt: string) {
    setBusy(true);
    try {
      const created = await createSession({
        initialMessage: prompt,
        resources: buildResources(manualRepos, githubRepos, selectedRepoIds, selectedRepoRefs),
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
    setSessionId(id);
    window.history.pushState({}, "", `/sessions/${id}`);
  }

  function goHome() {
    setSessionId(null);
    window.history.pushState({}, "", "/");
  }

  async function submitFollowUp(prompt: string) {
    if (!session || !prompt.trim()) {
      return;
    }
    setBusy(true);
    try {
      await sendUserMessage(session.id, prompt.trim());
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
      window.location.href = result.actionUrl;
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

  return (
    <main className="flex min-h-screen flex-col overflow-x-hidden bg-[color:var(--color-bg)] text-[color:var(--color-fg)]">
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
          <span>Infra Agent</span>
        </button>

        {session ? (
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
          {session ? <ConnectionPill state={connectionState} /> : null}
          {session ? <StatusBadge status={session.status} /> : null}
          {session ? (
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

      {!session ? (
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pt-10 pb-16 sm:px-6 sm:pt-16">
          <section className="flex flex-col items-center gap-2 text-center">
            <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
              What should the agent do?
            </h1>
            <p className="max-w-md text-sm text-[color:var(--color-fg-muted)]">
              Start a durable sandbox session with live streams, approvals, interrupts, and follow-ups.
            </p>
          </section>

          <section className="mt-8">
            <Composer
              autoFocus
              pending={busy}
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
                </div>
              }
              onSubmit={submitInitial}
            />
          </section>

          <RecentSessions onSelect={selectSession} />
        </div>
      ) : (
        <div className={cn("grid min-h-0 w-full min-w-0 flex-1 grid-cols-1 overflow-hidden", inspectorOpen && "lg:grid-cols-[minmax(0,1fr)_minmax(0,390px)]")}>
          <section className="flex min-h-0 min-w-0 flex-col">
            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-32 sm:px-6">
                {conversation.length === 0 ? (
                  <div className="grid min-h-[24rem] place-items-center rounded-lg border border-dashed border-[color:var(--color-border)] text-sm text-[color:var(--color-fg-subtle)]">
                    Waiting for session activity
                  </div>
                ) : (
                  <ConversationStream turns={conversation} />
                )}

                {approvals.length > 0 ? (
                  <div className="mt-6 grid gap-3">
                    {approvals.map((approval) => (
                      <div key={approval.id} className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                        <div className="text-sm font-medium">{approval.name}</div>
                        <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-[color:var(--color-bg)] p-3 text-xs text-[color:var(--color-fg-muted)]">
                          {JSON.stringify(approval.arguments ?? approval.raw ?? {}, null, 2)}
                        </pre>
                        <div className="mt-3 flex justify-end gap-2">
                          <Button size="sm" onClick={() => void sendApproval(session.id, approval.id, "approve")}>
                            <CheckIcon className="size-3.5" />
                            Approve
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => void sendApproval(session.id, approval.id, "reject")}>
                            <XIcon className="size-3.5" />
                            Reject
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </ScrollArea>

            <div className="sticky bottom-0 border-t border-[color:var(--color-border)] bg-[color:var(--color-bg)]/90 px-4 py-3 backdrop-blur sm:px-6">
              <div className="mx-auto w-full max-w-3xl">
                <Composer
                  pending={busy}
                  disabled={!canSendFollowUp || sessionRunning}
                  disabledHint={
                    sessionRunning
                      ? "Agent is running. Stop to interrupt."
                      : session.status !== "idle"
                        ? `Session is ${session.status}.`
                        : undefined
                  }
                  placeholder={sessionRunning ? "Agent is running..." : "Send a follow-up..."}
                  submitLabel={busy ? "Sending" : "Send"}
                  submitAction={
                    sessionRunning ? (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={interruptSession}
                        disabled={busy}
                        aria-label="Interrupt"
                        className="h-8 gap-1.5 px-3"
                      >
                        {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <SquareIcon className="size-3.5" />}
                        <span className="text-xs font-medium">Stop</span>
                      </Button>
                    ) : undefined
                  }
                  onSubmit={submitFollowUp}
                />
              </div>
            </div>
          </section>

          {inspectorOpen ? (
            <aside className="min-h-0 w-full min-w-0 overflow-hidden border-t border-[color:var(--color-border)] bg-[color:var(--color-surface)]/35 lg:border-t-0 lg:border-l">
              <SessionInspector session={session} events={events} connectionState={connectionState} />
            </aside>
          ) : null}
        </div>
      )}
    </main>
  );
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

function ConversationStream({ turns }: { turns: ConversationTurn[] }) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  return (
    <div className="space-y-6" data-testid="session-timeline">
      {turns.map((turn) => turn.kind === "user"
        ? <UserMessage key={turn.id} turn={turn} />
        : turn.kind === "assistant"
          ? <AssistantMessage key={turn.id} turn={turn} />
          : <ActivityMessage key={turn.id} turn={turn} />)}
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}

function UserMessage({ turn }: { turn: ConversationUserTurn }) {
  return (
    <article className="message-in flex justify-end gap-3">
      <div className="max-w-[82%] rounded-2xl rounded-br-sm border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] px-4 py-2.5 text-[15px] leading-relaxed">
        <ProseText text={turn.text} />
      </div>
      <AvatarBubble variant="user" />
    </article>
  );
}

function AssistantMessage({ turn }: { turn: ConversationAssistantTurn }) {
  const hasText = turn.text.trim().length > 0;
  return (
    <article className="message-in flex justify-start gap-3">
      <AvatarBubble variant="assistant" />
      <div className="min-w-0 max-w-[88%] space-y-3 text-[15px] leading-relaxed">
        {hasText ? (
          <div className="rounded-2xl rounded-bl-sm border border-transparent px-1 py-1 text-[color:var(--color-fg)]">
            <ProseText text={turn.text} />
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
    <article className="message-in flex justify-start gap-3">
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
  const shouldOpen = props.status === "running" || props.status === "requires_action";
  const [open, setOpen] = useState(shouldOpen);

  useEffect(() => {
    if (props.status === "complete") {
      setOpen(false);
    } else if (shouldOpen) {
      setOpen(true);
    }
  }, [props.status, shouldOpen]);

  const failed = props.trace.some((item) => item.status === "failed");
  const running = props.trace.some((item) => item.status === "running");
  const summary = traceSummary(props.trace);

  return (
    <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/50">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
      >
        <span className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full border",
          failed
            ? "border-red-400/35 bg-red-500/10 text-red-300"
            : running
              ? "border-amber-400/35 bg-amber-500/10 text-amber-300"
              : "border-emerald-400/35 bg-emerald-500/10 text-emerald-300",
        )}>
          {failed ? <AlertTriangleIcon className="size-3.5" /> : running ? <CircleDashedIcon className="size-3.5 animate-spin" /> : <CheckCircle2Icon className="size-3.5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-[color:var(--color-fg)]">
            {running ? "Working" : failed ? "Action failed" : "Agent activity"}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-[color:var(--color-fg-subtle)]">{summary}</span>
        </span>
        <ChevronDownIcon className={cn("size-4 shrink-0 text-[color:var(--color-fg-subtle)] transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="space-y-2 border-t border-[color:var(--color-border)] px-3 py-3">
          {props.trace.map((item) => <TraceItemView key={item.id} item={item} />)}
        </div>
      ) : null}
    </div>
  );
}

function TraceItemView({ item }: { item: ConversationTraceItem }) {
  return (
    <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2">
      <div className="flex justify-center pt-0.5">
        <TraceIcon item={item} />
      </div>
      <div className="min-w-0 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/35 p-2">
        <div className="flex items-center justify-between gap-3">
          <div className="truncate text-xs font-medium text-[color:var(--color-fg)]">{item.title}</div>
          <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium", traceStatusClass(item.status))}>
            {traceStatusLabel(item.status)}
          </span>
        </div>
        {item.detail ? (
          <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-[color:var(--color-surface)]/70 p-2 text-[11px] leading-5 text-[color:var(--color-fg-muted)]">
            {item.detail}
          </pre>
        ) : null}
        {item.output ? (
          <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/45 p-2 text-[11px] leading-5 text-[color:var(--color-fg-muted)]">
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

function ProseText({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap break-words">{text}</p>;
}

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
                        <div className="min-w-0 truncate text-xs font-medium">{String(resource.metadata.repo ?? resource.uri)}</div>
                        <div className="mt-1 min-w-0 truncate font-mono text-[11px] text-[color:var(--color-fg-subtle)]">{resource.uri}</div>
                        <div className="mt-2 flex min-w-0 flex-wrap gap-1.5 text-[11px] text-[color:var(--color-fg-subtle)]">
                          <span className="max-w-full truncate rounded border border-[color:var(--color-border)] px-1.5 py-0.5">ref {String(resource.metadata.ref ?? "main")}</span>
                          {resource.metadata.mount_path ? <span className="max-w-full truncate rounded border border-[color:var(--color-border)] px-1.5 py-0.5">{String(resource.metadata.mount_path)}</span> : null}
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
  return {
    ...event,
    payload: { kind: "model_activity" },
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

function useSessionStream(
  sessionId: string | null,
  after: number,
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
    onStateRef.current?.("connecting");
    const source = new EventSource(streamUrl(sessionId, after));
    source.onopen = () => onStateRef.current?.("live");
    source.onerror = () => onStateRef.current?.("error");
    const handler = (event: MessageEvent) => {
      onEventsRef.current([JSON.parse(event.data) as SessionEvent]);
    };
    for (const type of streamEventTypes) {
      source.addEventListener(type, handler);
    }
    return () => {
      for (const type of streamEventTypes) {
        source.removeEventListener(type, handler);
      }
      source.close();
      onStateRef.current?.("closed");
    };
  }, [sessionId]);
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
      metadata: {
        host: parsed.host,
        repo: parsed.repo,
        ref: repo.ref,
        subpath: null,
        mount_path: mountPath,
        github_repository_id: repo.repositoryId,
        github_installation_id: repo.installationId,
      },
    };
  });
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

function projectConversation(session: Session, events: SessionEvent[]): ConversationTurn[] {
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
      const activity = startActivity(event);
      activity.status = "running";
      const existing = findTrace(activity, `reasoning:${activity.id}`, "reasoning");
      if (existing) {
        existing.status = "running";
      } else {
        activity.trace.push({
          id: event.id,
          key: `reasoning:${activity.id}`,
          kind: "reasoning",
          status: "running",
          title: "Model reasoning",
          detail: "Internal reasoning is hidden.",
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
      const activity = lastActivity();
      if (activity) {
        activity.status = "complete";
        completeRunningActivity(activity);
        currentActivity = null;
      }
    }
  }
  if (out.length === 0 && session.initialMessage) {
    out.push({
      kind: "user",
      id: `user-${session.id}`,
      text: session.initialMessage,
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
  localStorage.setItem("infra-agent-recent-sessions", JSON.stringify(items));
}

function recentSessions(): Array<{ id: string; prompt: string; createdAt: string }> {
  try {
    const parsed = JSON.parse(localStorage.getItem("infra-agent-recent-sessions") ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => item?.id && item?.prompt && item?.createdAt) : [];
  } catch {
    return [];
  }
}
