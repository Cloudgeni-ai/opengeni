import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  LockIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Composer } from "@/components/app/Composer";
import { TopBar } from "@/components/app/TopBar";
import { RecentRunsList } from "@/components/home/RecentRunsList";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  createGitHubAppManifest,
  createRun,
  fetchGitHubAppStatus,
  fetchGitHubRepositories,
  syncGitHubRepositories,
} from "@/lib/api";
import { rememberRun } from "@/lib/known-runs";
import { runQueryOptions } from "@/lib/queries";
import type { GitHubRepository, ReasoningEffort, ResourceRef } from "@/lib/types";

const EXAMPLES = [
  "Summarize the top-level structure of /workspace.",
  "Read README.md and list the sections.",
  "Run `wc -l` on every Python file under packages/.",
] as const;

interface RepoDraft {
  id: number;
  url: string;
  ref: string;
}

interface CreateRunInput {
  prompt: string;
  resources: ResourceRef[];
  reasoningEffort: ReasoningEffort;
}

type IntelligenceEffort = Extract<ReasoningEffort, "low" | "medium" | "high" | "xhigh">;

const INTELLIGENCE_OPTIONS: Array<{ value: IntelligenceEffort; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
];

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [manualRepos, setManualRepos] = useState<RepoDraft[]>([]);
  const [nextRepoId, setNextRepoId] = useState(1);
  const [manualReposOpen, setManualReposOpen] = useState(false);
  const [githubAppOpen, setGithubAppOpen] = useState<boolean | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<IntelligenceEffort>("high");
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<number>>(() => new Set());
  const [selectedRepoRefs, setSelectedRepoRefs] = useState<Record<number, string>>({});
  const [githubOrg, setGithubOrg] = useState("");
  const [githubAppPending, setGithubAppPending] = useState(false);
  const githubAppStatus = useQuery({
    queryKey: ["github-app-status"],
    queryFn: fetchGitHubAppStatus,
  });
  const githubConfigured = githubAppStatus.data?.configured === true;
  const githubRepositories = useQuery({
    queryKey: ["github-repositories"],
    queryFn: fetchGitHubRepositories,
    enabled: githubConfigured,
    retry: false,
  });
  const syncRepositories = useMutation({
    mutationFn: syncGitHubRepositories,
    onSuccess: (data) => {
      queryClient.setQueryData(["github-repositories"], data);
      toast.success("Repositories refreshed", {
        description: `${data.repositories.length} repositories available.`,
      });
    },
    onError: (error: unknown) => {
      toast.error("Failed to refresh repositories", {
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const installedRepositories = githubRepositories.data?.repositories ?? [];
  const selectedInstalledRepositories = installedRepositories.filter((repo) =>
    selectedRepoIds.has(repo.id),
  );
  const selectedInstallationId =
    selectedInstalledRepositories[0]?.installation_id ?? null;
  const repositoryGroups = installedRepositories.reduce<
    Array<{
      installationId: number;
      label: string;
      detail: string;
      repositories: GitHubRepository[];
    }>
  >((groups, repo) => {
    let group = groups.find((item) => item.installationId === repo.installation_id);
    if (!group) {
      group = {
        installationId: repo.installation_id,
        label: repo.account_login,
        detail: repo.account_type ?? "GitHub account",
        repositories: [],
      };
      groups.push(group);
    }
    group.repositories.push(repo);
    return groups;
  }, []);
  const resolvedGithubAppOpen =
    githubAppOpen ?? (githubAppStatus.isSuccess ? !githubConfigured : false);

  useEffect(() => {
    if (githubAppStatus.isSuccess && githubAppOpen === null) {
      setGithubAppOpen(!githubConfigured);
    }
  }, [githubAppOpen, githubAppStatus.isSuccess, githubConfigured]);

  const mutation = useMutation({
    mutationFn: ({ prompt, resources, reasoningEffort }: CreateRunInput) =>
      createRun(prompt, resources, reasoningEffort),
    onMutate: () => setPending(true),
    onSuccess: async (run) => {
      rememberRun({ id: run.id, prompt: run.prompt, createdAt: run.created_at });
      queryClient.setQueryData(runQueryOptions(run.id).queryKey, run);
      await navigate({ to: "/runs/$runId", params: { runId: run.id } });
    },
    onError: (error: unknown) => {
      toast.error("Failed to start run", {
        description: error instanceof Error ? error.message : String(error),
      });
      setPending(false);
    },
  });

  function addRepo() {
    setManualRepos((current) => [...current, { id: nextRepoId, url: "", ref: "main" }]);
    setNextRepoId((value) => value + 1);
    setManualReposOpen(true);
  }

  function updateRepo(id: number, patch: Partial<RepoDraft>) {
    setManualRepos((current) =>
      current.map((repo) => (repo.id === id ? { ...repo, ...patch } : repo)),
    );
  }

  function removeRepo(id: number) {
    setManualRepos((current) => current.filter((repo) => repo.id !== id));
  }

  function toggleInstalledRepo(repo: GitHubRepository) {
    if (
      selectedInstallationId !== null &&
      selectedInstallationId !== repo.installation_id &&
      !selectedRepoIds.has(repo.id)
    ) {
      toast.info("This run uses one GitHub token", {
        description: "Clear the selected repositories to choose repositories from another account.",
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
    setSelectedRepoRefs((current) => ({
      ...current,
      [repo.id]: current[repo.id] ?? repo.default_branch,
    }));
  }

  function updateInstalledRepoRef(repoId: number, ref: string) {
    setSelectedRepoRefs((current) => ({ ...current, [repoId]: ref }));
  }

  function buildResources(): ResourceRef[] {
    const resources = [
      ...selectedInstalledRepositories.map((repo) => ({
        url: repo.clone_url,
        ref: (selectedRepoRefs[repo.id] ?? repo.default_branch).trim(),
        repositoryId: repo.id,
        installationId: repo.installation_id,
      })),
      ...manualRepos.map((repo) => ({
        url: repo.url.trim(),
        ref: repo.ref.trim(),
        repositoryId: null,
        installationId: null,
      })),
    ]
      .filter((repo) => repo.url.length > 0);
    const mountPaths = new Set<string>();
    return resources.map((repo) => {
      if (repo.ref.length === 0) {
        throw new Error("Repository ref is required.");
      }
      const parsed = normalizeRepositoryUrl(repo.url);
      const mountPath = "repos/" + parsed.repo;
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

  function submitRun(prompt: string) {
    let resources: ResourceRef[];
    try {
      resources = buildResources();
    } catch (error) {
      toast.error("Repository input is invalid", {
        description: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    mutation.mutate({ prompt, resources, reasoningEffort });
  }

  async function startGitHubAppManifestFlow() {
    setGithubAppPending(true);
    try {
      const result = await createGitHubAppManifest({
        organization: githubOrg.trim() || undefined,
      });
      submitGitHubManifestForm(result.action_url, result.manifest);
    } catch (error) {
      toast.error("GitHub App setup failed", {
        description: error instanceof Error ? error.message : String(error),
      });
      setGithubAppPending(false);
    }
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pt-16 pb-24 sm:px-6 sm:pt-24">
        <section className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
            What should the agent do?
          </h1>
          <p className="max-w-md text-sm text-[color:var(--color-fg-muted)]">
            Start a durable run in a sandbox. Follow-ups and cancels are live.
          </p>
        </section>

        <section className="mt-8">
          <div className="mb-4 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-xs uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
                  Repositories
                </Label>
                <p className="mt-1 text-xs text-[color:var(--color-fg-subtle)]">
                  {selectedRepoIds.size > 0
                    ? `${selectedRepoIds.size} selected for this run`
                    : "Optional. Select one or more installed GitHub repositories."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {githubAppStatus.data?.install_url ? (
                  <Button asChild type="button" variant="ghost" size="sm" className="h-7 text-xs">
                    <a href={githubAppStatus.data.install_url}>
                      <GitPullRequestIcon className="size-3.5" />
                      Install
                    </a>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => syncRepositories.mutate()}
                  disabled={!githubConfigured || syncRepositories.isPending}
                  className="h-7 gap-1.5 px-2 text-xs"
                >
                  <RefreshCwIcon
                    className={
                      syncRepositories.isPending ? "size-3.5 animate-spin" : "size-3.5"
                    }
                  />
                  Refresh
                </Button>
              </div>
            </div>

            <div className="mt-3">
              {!githubConfigured ? (
                <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/35 p-3 text-xs leading-5 text-[color:var(--color-fg-muted)]">
                  Configure the GitHub App setup below, install it on repositories, then refresh
                  this list.
                </div>
              ) : githubRepositories.isLoading ? (
                <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/35 p-3 text-xs text-[color:var(--color-fg-muted)]">
                  Loading repositories...
                </div>
              ) : githubRepositories.isError ? (
                <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/35 p-3 text-xs leading-5 text-[color:var(--color-fg-muted)]">
                  Repository sync failed. Check that the generated values are in
                  <code className="mx-1 rounded bg-[color:var(--color-surface-2)] px-1">
                    .env
                  </code>
                  and that the app is installed on at least one account.
                </div>
              ) : installedRepositories.length === 0 ? (
                <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/35 p-3 text-xs leading-5 text-[color:var(--color-fg-muted)]">
                  No installed repositories found. Install the app on selected repositories, then
                  refresh.
                </div>
              ) : (
                <div className="max-h-72 overflow-auto rounded-md border border-[color:var(--color-border)]">
                  {repositoryGroups.map((group) => (
                    <div key={group.installationId}>
                      <div className="flex items-center justify-between border-b border-[color:var(--color-border)] bg-[color:var(--color-bg)]/35 px-2 py-1.5 text-xs text-[color:var(--color-fg-subtle)]">
                        <span className="truncate font-medium text-[color:var(--color-fg-muted)]">
                          {group.label}
                        </span>
                        <span className="shrink-0">
                          {group.detail} · {group.repositories.length} repo
                          {group.repositories.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      {group.repositories.map((repo) => {
                        const checked = selectedRepoIds.has(repo.id);
                        const blocked =
                          selectedInstallationId !== null &&
                          selectedInstallationId !== repo.installation_id &&
                          !checked;
                        const row = (
                          <div
                            className={
                              blocked
                                ? "grid grid-cols-[auto_minmax(0,1fr)] gap-3 border-b border-[color:var(--color-border)] p-2 opacity-50 last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_8rem]"
                                : "grid grid-cols-[auto_minmax(0,1fr)] gap-3 border-b border-[color:var(--color-border)] p-2 last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_8rem]"
                            }
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleInstalledRepo(repo)}
                              disabled={pending || blocked}
                              aria-label={`Select ${repo.full_name}`}
                              className="mt-1 size-4 accent-[color:var(--color-brand)]"
                            />
                            <div className="min-w-0">
                              <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <span className="truncate text-sm font-medium">
                                  {repo.full_name}
                                </span>
                                <span className="inline-flex items-center gap-1 rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[11px] text-[color:var(--color-fg-subtle)]">
                                  {repo.private ? <LockIcon className="size-3" /> : null}
                                  {repo.private ? "Private" : "Public"}
                                </span>
                              </div>
                              <div className="mt-1 truncate text-xs text-[color:var(--color-fg-subtle)]">
                                default {repo.default_branch}
                              </div>
                            </div>
                            {checked ? (
                              <div className="relative col-start-2 sm:col-start-auto">
                                <GitBranchIcon className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-[color:var(--color-fg-subtle)]" />
                                <Input
                                  value={selectedRepoRefs[repo.id] ?? repo.default_branch}
                                  onChange={(event) =>
                                    updateInstalledRepoRef(repo.id, event.target.value)
                                  }
                                  disabled={pending}
                                  placeholder={repo.default_branch}
                                  aria-label={`${repo.full_name} ref`}
                                  className="h-8 pl-7 text-xs"
                                />
                              </div>
                            ) : null}
                          </div>
                        );
                        return blocked ? (
                          <Tooltip key={`${repo.installation_id}:${repo.id}`}>
                            <TooltipTrigger asChild>{row}</TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              This run uses one GitHub token. Start another run to use
                              repositories from this account.
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <div key={`${repo.installation_id}:${repo.id}`}>{row}</div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Collapsible
              open={resolvedGithubAppOpen}
              onOpenChange={setGithubAppOpen}
              className={
                githubConfigured
                  ? "mt-3 border-t border-[color:var(--color-border)] pt-2"
                  : "mt-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/35 p-3"
              }
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-xs text-[color:var(--color-fg-muted)]"
                  >
                    <ChevronDownIcon
                      className={
                        resolvedGithubAppOpen
                          ? "size-3.5 rotate-180 transition-transform"
                          : "size-3.5 transition-transform"
                      }
                    />
                    GitHub App setup
                    <span
                      className={
                        githubConfigured
                          ? "rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-300"
                          : "rounded-full border border-[color:var(--color-border)] px-1.5 py-0.5 text-[11px] text-[color:var(--color-fg-subtle)]"
                      }
                    >
                      {githubConfigured ? "Configured" : "Needs setup"}
                    </span>
                  </Button>
                </CollapsibleTrigger>
                {githubConfigured && githubAppStatus.data?.install_url ? (
                  <Button asChild type="button" variant="ghost" size="sm" className="h-7 text-xs">
                    <a href={githubAppStatus.data.install_url}>
                      <GitPullRequestIcon className="size-3.5" />
                      Install on repos
                    </a>
                  </Button>
                ) : null}
              </div>
              <CollapsibleContent className="pt-3">
                <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs leading-5 text-[color:var(--color-fg-muted)]">
                        {githubConfigured
                          ? `Using ${
                              githubAppStatus.data?.app_slug ?? "the configured app"
                            } for repository installs, tokens, pushes, and pull requests.`
                          : "Create a prefilled app once, add the generated values to .env, then restart the API and worker."}
                      </p>
                      {githubConfigured ? (
                        <div className="mt-2 grid gap-1 text-xs leading-5 text-[color:var(--color-fg-muted)] sm:grid-cols-2">
                          <div>
                            <span className="text-[color:var(--color-fg-subtle)]">App ID</span>{" "}
                            {githubAppStatus.data?.app_id}
                          </div>
                          <div>
                            <span className="text-[color:var(--color-fg-subtle)]">Client ID</span>{" "}
                            {githubAppStatus.data?.client_id}
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {githubAppStatus.data?.install_url ? (
                        <Button asChild type="button" variant="outline" size="sm">
                          <a href={githubAppStatus.data.install_url}>
                            <GitPullRequestIcon className="size-3.5" />
                            Install
                          </a>
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        onClick={startGitHubAppManifestFlow}
                        disabled={githubAppPending}
                      >
                        <GitPullRequestIcon className="size-3.5" />
                        {githubAppPending
                          ? "Opening GitHub"
                          : githubConfigured
                            ? "Create another"
                            : "Create app"}
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3">
                    <Label
                      htmlFor="github-org"
                      className="text-xs text-[color:var(--color-fg-subtle)]"
                    >
                      Organization
                    </Label>
                    <Input
                      id="github-org"
                      value={githubOrg}
                      onChange={(event) => setGithubOrg(event.target.value)}
                      placeholder="Optional org login"
                      disabled={githubAppPending}
                      className="mt-1 h-8 text-xs"
                    />
                  </div>
                  {!githubConfigured ? (
                    <ol className="mt-3 grid gap-2 text-xs leading-5 text-[color:var(--color-fg-muted)] sm:grid-cols-3">
                      <li className="rounded-md border border-[color:var(--color-border)] p-2">
                        1. Review the generated app on GitHub.
                      </li>
                      <li className="rounded-md border border-[color:var(--color-border)] p-2">
                        2. Add returned credentials to
                        <code className="ml-1 rounded bg-[color:var(--color-surface-2)] px-1">
                          .env
                        </code>
                        .
                      </li>
                      <li className="rounded-md border border-[color:var(--color-border)] p-2">
                        3. Install it on selected repositories.
                      </li>
                    </ol>
                  ) : null}
                </div>
              </CollapsibleContent>
            </Collapsible>

            <Collapsible
              open={manualReposOpen}
              onOpenChange={setManualReposOpen}
              className="mt-3 border-t border-[color:var(--color-border)] pt-2"
            >
              <div className="flex items-center justify-between gap-3">
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-xs text-[color:var(--color-fg-muted)]"
                  >
                    <ChevronDownIcon className="size-3.5" />
                    Add repositories by URL
                  </Button>
                </CollapsibleTrigger>
                {manualReposOpen ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={addRepo}
                    disabled={pending}
                    className="h-7 gap-1.5 px-2 text-xs"
                  >
                    <PlusIcon className="size-3.5" />
                    Add URL
                  </Button>
                ) : null}
              </div>
              <CollapsibleContent className="pt-2">
                {manualRepos.length === 0 ? (
                  <p className="px-2 pb-1 text-xs text-[color:var(--color-fg-subtle)]">
                    Add public or externally authenticated HTTPS Git repositories alongside
                    GitHub App selections. App token auth only applies to installed repositories
                    selected above.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {manualRepos.map((repo) => (
                      <div
                        key={repo.id}
                        className="grid grid-cols-[1fr_7.5rem_auto] gap-2 max-sm:grid-cols-[1fr_auto]"
                      >
                        <Input
                          value={repo.url}
                          onChange={(event) => updateRepo(repo.id, { url: event.target.value })}
                          disabled={pending}
                          placeholder="https://github.com/org/repo"
                          aria-label="Repository URL"
                          className="h-8 text-xs"
                        />
                        <div className="relative max-sm:col-start-1">
                          <GitBranchIcon className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-[color:var(--color-fg-subtle)]" />
                          <Input
                            value={repo.ref}
                            onChange={(event) => updateRepo(repo.id, { ref: event.target.value })}
                            disabled={pending}
                            placeholder="main"
                            aria-label="Repository ref"
                            className="h-8 pl-7 text-xs"
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => removeRepo(repo.id)}
                          disabled={pending}
                          aria-label="Remove repository"
                          className="size-8 text-[color:var(--color-fg-muted)]"
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>
          </div>
          <Composer
            autoFocus
            pending={pending}
            placeholder="Describe a task for the agent..."
            submitLabel={pending ? "Starting" : "Send"}
            examples={EXAMPLES}
            controlsBeforeSubmit={
              <ModelPicker
                value={reasoningEffort}
                disabled={pending}
                onChange={setReasoningEffort}
              />
            }
            onSubmit={submitRun}
          />
        </section>

        <section className="mt-12">
          <h2 className="text-xs font-medium uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
            Recent runs
          </h2>
          <RecentRunsList />
        </section>
      </main>
    </>
  );
}

function ModelPicker({
  value,
  disabled,
  onChange,
}: {
  value: IntelligenceEffort;
  disabled?: boolean;
  onChange: (value: IntelligenceEffort) => void;
}) {
  const selected = INTELLIGENCE_OPTIONS.find((option) => option.value === value);
  const label = selected?.label ?? "High";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label="Model and intelligence"
          className="h-8 gap-1 rounded-full px-2.5 text-xs text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-fg)]"
        >
          <span className="font-medium text-[color:var(--color-fg)]">5.5</span>
          <span>{label}</span>
          <ChevronDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        sideOffset={8}
        className="w-52 rounded-xl border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-2 shadow-xl"
      >
        <DropdownMenuLabel className="px-2 pt-1 pb-1 text-xs font-normal text-[color:var(--color-fg-subtle)]">
          Intelligence
        </DropdownMenuLabel>
        {INTELLIGENCE_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onChange(option.value)}
            className="h-8 cursor-pointer rounded-md px-2 text-sm text-[color:var(--color-fg)] focus:bg-[color:var(--color-surface-2)]"
          >
            <span>{option.label}</span>
            {option.value === value ? (
              <CheckIcon className="ml-auto size-4 text-[color:var(--color-fg)]" />
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator className="my-2 bg-[color:var(--color-border)]" />
        <DropdownMenuLabel className="px-2 pt-0 pb-1 text-xs font-normal text-[color:var(--color-fg-subtle)]">
          Model
        </DropdownMenuLabel>
        <DropdownMenuItem
          disabled
          className="h-8 rounded-md px-2 text-sm text-[color:var(--color-fg)] opacity-100"
        >
          <span>GPT-5.5</span>
          <CheckIcon className="ml-auto size-4 text-[color:var(--color-fg)]" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function submitGitHubManifestForm(
  actionUrl: string,
  manifest: Record<string, unknown>,
) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = actionUrl;
  form.style.display = "none";

  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = JSON.stringify(manifest);
  form.appendChild(input);

  document.body.appendChild(form);
  form.submit();
}

function normalizeRepositoryUrl(input: string): { host: string; repo: string } {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Repository URL must be a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.length === 0) {
    throw new Error("Repository URL must use https://.");
  }
  let path = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (path.endsWith(".git")) {
    path = path.slice(0, -4);
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Repository URL must include an owner/path and repository name.");
  }
  return {
    host: parsed.host.toLowerCase(),
    repo: parts.join("/"),
  };
}
