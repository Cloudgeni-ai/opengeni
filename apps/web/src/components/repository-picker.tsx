import {
  CheckIcon,
  ChevronDownIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  Loader2Icon,
  LockIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { ScrollArea } from "@/components/ui/scroll-area";
import { repoCountLabel } from "@/lib/format";
import {
  gitHubRepositoryResource,
  isRepositoryResourceForGitHubRepo,
  sameRepositoryUri,
  type RepoDraft,
  type RepositoryGroup,
} from "@/lib/session-tools";
import { cn } from "@/lib/utils";
import type { GitHubRepository, ResourceRef } from "@/types";

export function RepositoryContextPicker(props: {
  configured: boolean;
  installUrl: string | null;
  repositories: GitHubRepository[];
  groups: RepositoryGroup[];
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
  const hasRepos = props.repositories.length > 0;
  // Two-step inline confirm for removing a manual repo, so a stray click in a
  // dense picker doesn't drop a repo the user typed out.
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);

  // The GitHub App manifest form — org login plus the install/create actions.
  // Rendered inline (open) in the first-run empty state so setup is never hidden
  // behind a disclosure, and demoted into a quiet "GitHub app settings"
  // disclosure once repositories are connected.
  const setupForm = (
    <div className="space-y-3">
      <p className="text-xs leading-5 text-fg-muted">
        {props.configured
          ? "The app provides repository listing, scoped clone tokens, pushes, and pull requests."
          : "Create a prefilled app, add the generated values to your .env, then restart the API and worker."}
      </p>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <Label htmlFor="github-org-menu" className="text-2xs text-fg-subtle">Organization</Label>
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
  );

  // The recovery path must stay reachable in EVERY configured state — including
  // configured-but-zero-repos (the stale-app case), where installUrl may be
  // absent and the settings form is the only way to reconnect or re-create.
  const settingsDisclosure = (
    <Collapsible open={props.githubAppOpen} onOpenChange={props.onGitHubAppOpenChange}>
      <div className="rounded-lg border border-border bg-bg/25">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-fg transition-colors hover:bg-surface-2/60"
          >
            <ChevronDownIcon className={cn("size-3.5 shrink-0 text-fg-subtle transition-transform", props.githubAppOpen && "rotate-180")} />
            <span className="truncate">GitHub app settings</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border p-3">{setupForm}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );


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
            "text-fg-muted hover:border-border hover:bg-surface-2 hover:text-fg",
            selectedCount > 0 && "border-brand/35 bg-brand/10 text-fg",
          )}
        >
          <GitBranchIcon className="size-3.5" />
          <span className="truncate">{selectedCount > 0 ? repoCountLabel(selectedCount) : "Repos"}</span>
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              props.configured ? "bg-status-idle" : "bg-status-waiting",
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
        className="w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-xl border-border bg-surface p-0 shadow-2xl"
      >
        <div onKeyDown={(event) => event.stopPropagation()}>
          <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-fg">Repository context</div>
              <div className="mt-0.5 truncate text-2xs text-fg-subtle">
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
              {!props.configured ? (
                <div className="space-y-3">
                  <EmptyState
                    icon={<GitBranchIcon className="size-5" />}
                    title="No repositories connected"
                    description="Connect the GitHub app so the sandbox can clone your repositories, push branches, and open pull requests."
                  />
                  <div className="rounded-lg border border-border bg-bg/25 p-3">{setupForm}</div>
                </div>
              ) : props.repoBusy ? (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-bg/25 p-3 text-xs text-fg-muted">
                  <Loader2Icon className="size-3.5 animate-spin" />
                  Loading repositories…
                </div>
              ) : !hasRepos ? (
                <div className="space-y-3">
                  <EmptyState
                    icon={<GitBranchIcon className="size-5" />}
                    title="No repositories connected"
                    description="The connected GitHub app isn't sharing any repositories with this workspace yet."
                    action={
                      props.installUrl ? (
                        <Button asChild type="button" variant="outline" size="sm" className="h-8 text-xs">
                          <a href={props.installUrl}>
                            <GitPullRequestIcon className="size-3.5" />
                            Reinstall on GitHub
                          </a>
                        </Button>
                      ) : undefined
                    }
                  />
                  <Notice tone="waiting">
                    If repositories are missing, the app may have been removed on GitHub — reinstall it.
                  </Notice>
                  {settingsDisclosure}
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-bg/25 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <MetaChip dot="idle" rounded="full">GitHub app</MetaChip>
                      {props.org ? (
                        <span className="min-w-0 truncate text-2xs text-fg-subtle" title={props.org}>{props.org}</span>
                      ) : null}
                    </div>
                    {props.installUrl ? (
                      <a
                        href={props.installUrl}
                        className="shrink-0 text-2xs text-fg-subtle underline-offset-2 transition-colors hover:text-fg hover:underline"
                      >
                        Reconnect
                      </a>
                    ) : null}
                  </div>

                  <section className="overflow-hidden rounded-lg border border-border bg-bg/25">
                    <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
                      <div className="min-w-0 truncate text-xs font-medium text-fg">Repositories</div>
                      <div className="shrink-0 text-2xs text-fg-subtle">{props.repositories.length} available</div>
                    </div>
                    <div className="max-h-80 overflow-auto">
                      {props.groups.map((group) => (
                        <div key={group.installationId} className="border-b border-border last:border-b-0">
                          <div className="flex items-center justify-between gap-3 bg-surface/45 px-3 py-1.5">
                            <div className="min-w-0 truncate text-2xs font-medium text-fg-muted">{group.label}</div>
                            <div className="shrink-0 text-2xs uppercase tracking-wide text-fg-subtle">{group.repositories.length} repos</div>
                          </div>
                          <div className="divide-y divide-border/70">
                            {group.repositories.map((repo) => {
                              const checked = props.selectedRepoIds.has(repo.id);
                              const blocked = props.selectedInstallationId !== null && props.selectedInstallationId !== repo.installationId && !checked;
                              return (
                                <div key={`${repo.installationId}:${repo.id}`} className={cn("px-2 py-2 transition-colors hover:bg-surface-2/45", blocked && "opacity-55")}>
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
                                          ? "border-brand bg-brand-strong text-brand-fg"
                                          : "border-border-strong bg-surface",
                                      )}
                                    >
                                      {checked ? <CheckIcon className="size-3" /> : null}
                                    </span>
                                    <span className="min-w-0">
                                      <span className="flex min-w-0 items-center gap-1.5">
                                        <span className="truncate text-xs font-medium text-fg">{repo.fullName}</span>
                                        {repo.private ? <LockIcon className="size-3 shrink-0 text-fg-subtle" /> : null}
                                      </span>
                                      <span className="mt-0.5 block truncate text-2xs text-fg-subtle">
                                        default {repo.defaultBranch}
                                      </span>
                                    </span>
                                    {blocked ? (
                                      <MetaChip dot="waiting" rounded="full">Other app</MetaChip>
                                    ) : checked ? (
                                      <MetaChip dot="idle" rounded="full">Selected</MetaChip>
                                    ) : null}
                                  </button>
                                  {checked ? (
                                    <div className="mt-2 flex items-center gap-2 pl-6">
                                      <GitBranchIcon className="size-3.5 shrink-0 text-fg-subtle" />
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
                  </section>

                  {settingsDisclosure}
                </>
              )}

              <Collapsible open={props.manualOpen} onOpenChange={props.onManualOpenChange}>
                <div className="rounded-lg border border-border bg-bg/25">
                  <div className="flex items-center justify-between gap-2 px-3 py-2">
                    <CollapsibleTrigger asChild>
                      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left text-xs font-medium text-fg">
                        <ChevronDownIcon className={cn("size-3.5 shrink-0 text-fg-subtle transition-transform", props.manualOpen && "rotate-180")} />
                        <span className="truncate">Add by URL</span>
                        {manualCount > 0 ? <MetaChip rounded="full">{manualCount}</MetaChip> : null}
                      </button>
                    </CollapsibleTrigger>
                    <Button type="button" variant="ghost" size="xs" onClick={props.onManualAdd} disabled={props.pending} className="h-7 text-xs">
                      <PlusIcon className="size-3" />
                      Add
                    </Button>
                  </div>

                  <CollapsibleContent>
                    <div className="space-y-2 border-t border-border p-3">
                      {props.manualRepos.length === 0 ? (
                        <p className="text-xs leading-5 text-fg-muted">
                          Add HTTPS Git repositories that don't use the GitHub app token.
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
                              <GitBranchIcon className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-fg-subtle" />
                              <Input
                                value={repo.ref}
                                onChange={(event) => props.onManualUpdate(repo.id, { ref: event.target.value })}
                                disabled={props.pending}
                                placeholder="main"
                                className="h-8 pl-7 text-xs"
                              />
                            </div>
                            {confirmRemoveId === repo.id ? (
                              <div className="flex items-center gap-1">
                                <Button
                                  type="button"
                                  variant="destructive"
                                  size="icon-sm"
                                  onClick={() => {
                                    props.onManualRemove(repo.id);
                                    setConfirmRemoveId(null);
                                  }}
                                  disabled={props.pending}
                                  aria-label="Confirm remove repository"
                                  title="Remove"
                                  className="size-8"
                                >
                                  <CheckIcon className="size-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => setConfirmRemoveId(null)}
                                  aria-label="Keep repository"
                                  title="Cancel"
                                  className="size-8"
                                >
                                  <XIcon className="size-3.5" />
                                </Button>
                              </div>
                            ) : (
                              <Button type="button" variant="ghost" size="icon-sm" onClick={() => setConfirmRemoveId(repo.id)} disabled={props.pending} aria-label="Remove repository" title="Remove" className="size-8">
                                <Trash2Icon className="size-3.5" />
                              </Button>
                            )}
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

export function ScheduledTaskRepositoryPicker(props: {
  configured: boolean;
  repositories: GitHubRepository[];
  groups: RepositoryGroup[];
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
      toast.error("Couldn't select the repository", { description: error instanceof Error ? error.message : String(error) });
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
    <section className="overflow-hidden rounded-lg border border-border bg-bg/25">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div>
          <div className="text-xs font-medium text-fg">Repositories</div>
          <div className="mt-0.5 text-2xs text-fg-subtle">{repoCountLabel(repositoryResources.length)} attached to this task</div>
        </div>
        <Button type="button" variant="ghost" size="xs" onClick={() => void props.onRefresh()} disabled={!props.configured || props.repoBusy || props.busy}>
          <RefreshCwIcon className={cn("size-3", props.repoBusy && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {!props.configured ? (
        <div className="p-3 text-xs leading-5 text-fg-muted">Configure the GitHub App to select repositories for scheduled runs.</div>
      ) : props.repoBusy ? (
        <div className="flex items-center gap-2 p-3 text-xs text-fg-muted">
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading repositories
        </div>
      ) : props.repositories.length === 0 ? (
        <div className="p-3 text-xs leading-5 text-fg-muted">No installed repositories found.</div>
      ) : (
        <div className="max-h-72 overflow-auto">
          {props.groups.map((group) => (
            <div key={group.installationId} className="border-b border-border last:border-b-0">
              <div className="flex items-center justify-between gap-3 bg-surface/45 px-3 py-1.5">
                <div className="min-w-0 truncate text-2xs font-medium text-fg-muted">{group.label}</div>
                <div className="shrink-0 text-2xs uppercase tracking-wide text-fg-subtle">{group.repositories.length} repos</div>
              </div>
              <div className="divide-y divide-border/70">
                {group.repositories.map((repo) => {
                  const resource = repositoryResources.find((item) => isRepositoryResourceForGitHubRepo(item, repo));
                  const checked = Boolean(resource);
                  const blocked = selectedInstallationId !== null && selectedInstallationId !== repo.installationId && !checked;
                  return (
                    <div key={`${repo.installationId}:${repo.id}`} className={cn("px-2 py-2 transition-colors hover:bg-surface-2/45", blocked && "opacity-55")}>
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
                              ? "border-brand bg-brand-strong text-brand-fg"
                              : "border-border-strong bg-surface",
                          )}
                        >
                          {checked ? <CheckIcon className="size-3" /> : null}
                        </span>
                        <span className="min-w-0">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-xs font-medium text-fg">{repo.fullName}</span>
                            {repo.private ? <LockIcon className="size-3 shrink-0 text-fg-subtle" /> : null}
                          </span>
                          <span className="mt-0.5 block truncate text-2xs text-fg-subtle">default {repo.defaultBranch}</span>
                        </span>
                        {blocked ? (
                          <MetaChip dot="waiting" rounded="full">Other app</MetaChip>
                        ) : checked ? (
                          <MetaChip dot="idle" rounded="full">Selected</MetaChip>
                        ) : null}
                      </button>
                      {resource ? (
                        <div className="mt-2 flex items-center gap-2 pl-6">
                          <GitBranchIcon className="size-3.5 shrink-0 text-fg-subtle" />
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
        <div className="border-t border-border px-3 py-2 text-2xs text-fg-subtle">
          Preserving {preservedRepositoryResources.length} manual repository resource{preservedRepositoryResources.length === 1 ? "" : "s"}
          {fileResources.length > 0 ? ` and ${fileResources.length} file resource${fileResources.length === 1 ? "" : "s"}` : ""}.
        </div>
      ) : null}
    </section>
  );
}
