import {
  CheckIcon,
  ChevronDownIcon,
  GitBranchIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { RepositoryContextPickerProps } from "@/components/repository-picker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { MetaChip } from "@/components/ui/meta-chip";
import { repoCountLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

type FollowUpRepositoryPickerProps = RepositoryContextPickerProps;

function selectedCount(props: FollowUpRepositoryPickerProps): number {
  return (
    props.selectedRepoIds.size +
    props.manualRepos.filter((repository) => repository.url.trim().length > 0).length
  );
}

/**
 * Existing sessions need only an additive repository surface: mounted rows are
 * immutable and the remaining rows are pending on the next accepted message.
 * Keeping this compact surface session-local also avoids pulling the larger
 * new-session GitHub setup flow into the application shell.
 */
export function FollowUpRepositoryMenuBody(
  props: FollowUpRepositoryPickerProps & { leading?: ReactNode },
) {
  const count = selectedCount(props);

  return (
    <div onKeyDown={(event) => event.stopPropagation()} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2.5">
        <div className="flex min-w-0 items-start gap-1">
          {props.leading}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-fg">Repository context</div>
            <div className="mt-0.5 truncate text-2xs text-fg-subtle">
              {count > 0
                ? `${repoCountLabel(count)} selected for this session`
                : "Add repositories with the next message"}
            </div>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => void props.onRefresh()}
          disabled={props.repoBusy || props.pending}
          aria-label="Refresh repositories"
          className="size-7"
        >
          <RefreshCwIcon className={cn("size-3.5", props.repoBusy && "animate-spin")} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain p-2.5">
        {props.repoBusy ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-bg/25 p-3 text-xs text-fg-muted">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading repositories…
          </div>
        ) : props.repositories.length > 0 ? (
          <section className="overflow-hidden rounded-lg border border-border bg-bg/25">
            <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
              <div className="min-w-0 truncate text-xs font-medium text-fg">
                GitHub repositories
              </div>
              <div className="shrink-0 text-2xs text-fg-subtle">
                {props.repositories.length} available
              </div>
            </div>
            {props.groups.map((group) => (
              <div key={group.installationId} className="border-b border-border last:border-b-0">
                <div className="bg-surface/45 px-3 py-1.5 text-2xs font-medium text-fg-muted">
                  {group.label}
                </div>
                <div className="divide-y divide-border/70">
                  {group.repositories.map((repository) => {
                    const checked = props.selectedRepoIds.has(repository.id);
                    const locked = props.lockedRepoIds?.has(repository.id) === true;
                    const blocked =
                      props.selectedInstallationId !== null &&
                      props.selectedInstallationId !== repository.installationId &&
                      !checked;
                    return (
                      <div
                        key={`${repository.installationId}:${repository.id}`}
                        className={cn("px-2 py-2", blocked && "opacity-55")}
                      >
                        <button
                          type="button"
                          onClick={() => props.onToggleRepo(repository)}
                          disabled={props.pending || locked}
                          aria-pressed={checked}
                          aria-label={
                            locked
                              ? `${repository.fullName} mounted`
                              : `Select ${repository.fullName}`
                          }
                          className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md text-left"
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
                            <span className="block truncate text-xs font-medium text-fg">
                              {repository.fullName}
                            </span>
                            <span className="mt-0.5 block truncate text-2xs text-fg-subtle">
                              default {repository.defaultBranch}
                            </span>
                          </span>
                          {locked ? (
                            <MetaChip dot="idle" rounded="full">
                              Mounted
                            </MetaChip>
                          ) : blocked ? (
                            <MetaChip dot="waiting" rounded="full">
                              Other app
                            </MetaChip>
                          ) : checked ? (
                            <MetaChip dot="idle" rounded="full">
                              Selected
                            </MetaChip>
                          ) : null}
                        </button>
                        {checked ? (
                          <div className="mt-2 flex items-center gap-2 pl-6">
                            <GitBranchIcon className="size-3.5 shrink-0 text-fg-subtle" />
                            <Input
                              value={
                                props.selectedRepoRefs[repository.id] ?? repository.defaultBranch
                              }
                              onChange={(event) =>
                                props.onRefChange(repository.id, event.target.value)
                              }
                              disabled={props.pending || locked}
                              placeholder={repository.defaultBranch}
                              aria-label={`${repository.fullName} ref`}
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
          </section>
        ) : (
          <div className="rounded-lg border border-border bg-bg/25 p-3 text-xs leading-5 text-fg-muted">
            No GitHub repositories are connected. You can still add a public repository by URL.
          </div>
        )}

        <section className="overflow-hidden rounded-lg border border-border bg-bg/25">
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <div>
              <div className="text-xs font-medium text-fg">Repository URL</div>
              <div className="mt-0.5 text-2xs text-fg-subtle">HTTPS repositories only</div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={props.onManualAdd}
              disabled={props.pending}
              className="h-7 text-xs"
            >
              <PlusIcon className="size-3" />
              Add
            </Button>
          </div>
          {props.manualRepos.length > 0 ? (
            <div className="space-y-2 border-t border-border p-3">
              {props.manualRepos.map((repository) => {
                const locked = props.lockedManualRepoIds?.has(repository.id) === true;
                return (
                  <div
                    key={repository.id}
                    className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_auto]"
                  >
                    <Input
                      value={repository.url}
                      onChange={(event) =>
                        props.onManualUpdate(repository.id, { url: event.target.value })
                      }
                      disabled={props.pending || locked}
                      placeholder="https://github.com/org/repo"
                      className="h-8 text-xs"
                    />
                    <Input
                      value={repository.ref}
                      onChange={(event) =>
                        props.onManualUpdate(repository.id, { ref: event.target.value })
                      }
                      disabled={props.pending || locked}
                      placeholder="main"
                      aria-label="Repository ref"
                      className="h-8 text-xs"
                    />
                    {locked ? (
                      <MetaChip dot="idle" rounded="full" className="self-center">
                        Mounted
                      </MetaChip>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => props.onManualRemove(repository.id)}
                        disabled={props.pending}
                        aria-label="Remove repository"
                        className="size-8"
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>

        {props.validationError ? (
          <p className="px-1 text-xs leading-5 text-status-failed" role="alert">
            {props.validationError}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function FollowUpRepositoryPicker(props: FollowUpRepositoryPickerProps) {
  const count = selectedCount(props);
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
            count > 0 && "border-brand/35 bg-brand/10 text-fg",
            props.triggerClassName,
          )}
        >
          <GitBranchIcon className="size-3.5" />
          <span className="truncate">{count > 0 ? repoCountLabel(count) : "Repos"}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="flex w-[min(560px,calc(100vw-2rem))] max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] flex-col overflow-hidden rounded-xl border-border bg-surface p-0 shadow-2xl"
      >
        <FollowUpRepositoryMenuBody {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
