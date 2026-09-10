import { CheckIcon, LockIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type {
  PersonalGitHubRepositoryAccess,
  PersonalGitHubRepositoryCatalogItem,
  PersonalGitHubRepositorySelectionInput,
} from "@opengeni/sdk";

function canWrite(repository: PersonalGitHubRepositoryCatalogItem): boolean {
  return (
    repository.permissions.push || repository.permissions.maintain || repository.permissions.admin
  );
}

export function PersonalGitHubDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  login: string;
  repositories: PersonalGitHubRepositoryCatalogItem[];
  busy: boolean;
  onSave: (repositories: PersonalGitHubRepositorySelectionInput[]) => Promise<boolean>;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Record<string, PersonalGitHubRepositoryAccess>>({});

  useEffect(() => {
    if (!props.open) return;
    setQuery("");
    setSelected(
      Object.fromEntries(
        props.repositories.flatMap((repository) =>
          repository.selectedAccess
            ? [
                [
                  repository.repositoryId,
                  repository.selectedAccess === "write" && !canWrite(repository)
                    ? "read"
                    : repository.selectedAccess,
                ] as const,
              ]
            : [],
        ),
      ),
    );
  }, [props.open, props.repositories]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? props.repositories.filter((repository) =>
          repository.fullName.toLowerCase().includes(needle),
        )
      : props.repositories;
  }, [props.repositories, query]);

  async function save() {
    const repositories = props.repositories.flatMap((repository) => {
      const access = selected[repository.repositoryId];
      return access
        ? [{ repositoryId: repository.repositoryId, fullName: repository.fullName, access }]
        : [];
    });
    if (await props.onSave(repositories)) props.onOpenChange(false);
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Your GitHub identity</DialogTitle>
          <DialogDescription>
            Connected as @{props.login}. Choose the repositories OpenGeni may use as you.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-2.5 size-4 text-fg-subtle" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a repository"
            aria-label="Find a GitHub repository"
            className="pl-9"
          />
        </div>

        <div className="max-h-[48vh] divide-y divide-border overflow-y-auto border-y border-border">
          {visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-fg-muted">No repositories found.</p>
          ) : (
            visible.map((repository) => {
              const access = selected[repository.repositoryId];
              const repositoryCanWrite = canWrite(repository);
              return (
                <div
                  key={repository.repositoryId}
                  className="grid grid-cols-[auto_minmax(0,1fr)_8rem] items-center gap-3 py-2.5"
                >
                  <button
                    type="button"
                    aria-label={`${access ? "Remove" : "Allow"} ${repository.fullName}`}
                    aria-pressed={Boolean(access)}
                    disabled={props.busy || repository.disabled}
                    onClick={() =>
                      setSelected((current) => {
                        const next = { ...current };
                        if (next[repository.repositoryId]) delete next[repository.repositoryId];
                        else next[repository.repositoryId] = repositoryCanWrite ? "write" : "read";
                        return next;
                      })
                    }
                    className="flex size-5 items-center justify-center rounded border border-border-strong bg-surface text-brand-fg aria-pressed:border-brand aria-pressed:bg-brand-strong disabled:opacity-50"
                  >
                    {access ? <CheckIcon className="size-3.5" /> : null}
                  </button>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-fg">
                        {repository.fullName}
                      </span>
                      {repository.private ? (
                        <LockIcon className="size-3 shrink-0 text-fg-subtle" />
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-2xs text-fg-subtle">
                      Default branch {repository.defaultBranch}
                    </div>
                  </div>
                  {access ? (
                    <Select
                      value={access}
                      disabled={props.busy || !repositoryCanWrite}
                      onChange={(event) =>
                        setSelected((current) => ({
                          ...current,
                          [repository.repositoryId]: event.target
                            .value as PersonalGitHubRepositoryAccess,
                        }))
                      }
                      aria-label={`${repository.fullName} access`}
                      className="h-8 text-xs"
                    >
                      <option value="read">Read only</option>
                      <option value="write" disabled={!repositoryCanWrite}>
                        Read and write
                      </option>
                    </Select>
                  ) : (
                    <span />
                  )}
                </div>
              );
            })
          )}
        </div>

        <p className="text-xs leading-5 text-fg-muted">
          GitHub grants account-wide OAuth access. This list is OpenGeni's additional allowlist.
          Repository writes still follow the GitHub action approvals configured on this integration.
        </p>

        <DialogFooter>
          <div className="flex flex-1 gap-1">
            <Button
              type="button"
              variant="ghost"
              onClick={props.onDisconnect}
              disabled={props.busy}
              className="text-status-failed"
            >
              Disconnect
            </Button>
            <Button type="button" variant="ghost" onClick={props.onReconnect} disabled={props.busy}>
              Reconnect
            </Button>
          </div>
          <Button type="button" onClick={() => void save()} disabled={props.busy}>
            Save repositories
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
