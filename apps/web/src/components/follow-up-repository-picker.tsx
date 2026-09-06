import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";

import type { RepositoryContextPickerProps } from "@/components/repository-picker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { repoCountLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

type FollowUpRepositoryPickerProps = RepositoryContextPickerProps;

const LazyFollowUpRepositoryMenuBody = lazy(() =>
  import("@/components/follow-up-repository-menu-body").then((module) => ({
    default: module.FollowUpRepositoryMenuBody,
  })),
);

function selectedCount(props: FollowUpRepositoryPickerProps): number {
  return (
    props.selectedRepoIds.size +
    (props.selectedPersonalGitHubRepoIds?.size ?? 0) +
    props.manualRepos.filter(
      (repository) => repository.attached !== false && repository.url.trim().length > 0,
    ).length
  );
}

export function FollowUpRepositoryMenuBody(
  props: FollowUpRepositoryPickerProps & { leading?: ReactNode },
) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-24 items-center justify-center gap-1 text-xs text-fg-muted">
          {props.leading}
          <span>Loading repositories…</span>
        </div>
      }
    >
      <LazyFollowUpRepositoryMenuBody {...props} />
    </Suspense>
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
