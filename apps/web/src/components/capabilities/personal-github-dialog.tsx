import { CheckIcon, LockIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@opengeni/react/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@opengeni/react/ui/dialog";
import { Input } from "@opengeni/react/ui/input";
import { Select } from "@opengeni/react/ui/select";
import type {
  PersonalGitHubRepositoryAccess,
  PersonalGitHubRepositoryCatalogItem,
  PersonalGitHubRepositorySelectionInput,
  PersonalGitHubSelectedRepository,
} from "@opengeni/sdk";

function canWrite(repository: Pick<PersonalGitHubRepositoryCatalogItem, "permissions">): boolean {
  return (
    repository.permissions.push || repository.permissions.maintain || repository.permissions.admin
  );
}

export function PersonalGitHubDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  login: string;
  repositories: PersonalGitHubRepositoryCatalogItem[];
  /**
   * The saved per-repository choice, which "Choose repositories" restores.
   * Without it, the catalog's `selectedAccess` marks are the choice.
   */
  savedRepositories?: PersonalGitHubSelectedRepository[] | undefined;
  /** All my repositories, at this access; null when only chosen repositories. */
  allRepositoriesAccess?: PersonalGitHubRepositoryAccess | null | undefined;
  /** All my repositories can be turned on here. It stays offered while it is on. */
  allRepositoriesAvailable?: boolean | undefined;
  /** The repository list is still loading from GitHub. */
  loading?: boolean;
  busy: boolean;
  onSave: (
    repositories: PersonalGitHubRepositorySelectionInput[],
    allRepositoriesAccess: PersonalGitHubRepositoryAccess | null,
  ) => Promise<boolean>;
  /** Finds repositories past the loaded list; results arrive through `repositories`. */
  onSearch?: ((query: string) => Promise<void>) | undefined;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Record<string, PersonalGitHubRepositoryAccess>>({});
  const [allAccess, setAllAccess] = useState<PersonalGitHubRepositoryAccess | null>(null);
  const [searching, setSearching] = useState(false);
  const onSearch = useRef(props.onSearch);
  onSearch.current = props.onSearch;
  const savedChoice: ReadonlyArray<
    Pick<PersonalGitHubSelectedRepository, "repositoryId" | "permissions"> & {
      selectedAccess: PersonalGitHubRepositoryAccess | null;
    }
  > = props.savedRepositories ?? props.repositories;

  useEffect(() => {
    if (!props.open) return;
    setQuery("");
    setAllAccess(props.allRepositoriesAccess ?? null);
    setSelected(
      Object.fromEntries(
        savedChoice.flatMap((repository) =>
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
  }, [props.open, savedChoice, props.allRepositoriesAccess]);

  useEffect(() => {
    const needle = query.trim();
    if (!props.open || needle.length < 2 || !onSearch.current) return;
    let active = true;
    const timer = setTimeout(() => {
      setSearching(true);
      void onSearch
        .current?.(needle)
        .catch(() => undefined)
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
      setSearching(false);
    };
  }, [props.open, query]);

  // Saved repositories the list has not loaded stay visible, so they can be removed.
  const listed = useMemo(() => {
    const known = new Set(props.repositories.map((repository) => repository.repositoryId));
    const extra = (props.savedRepositories ?? []).filter(
      (repository) => !known.has(repository.repositoryId),
    );
    return extra.length > 0 ? [...props.repositories, ...extra] : props.repositories;
  }, [props.repositories, props.savedRepositories]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? listed.filter((repository) => repository.fullName.toLowerCase().includes(needle))
      : listed;
  }, [listed, query]);

  async function save() {
    // Listed order first, then saved repositories the list has not loaded.
    const names = new Map<string, string>();
    for (const repository of props.repositories) {
      names.set(repository.repositoryId, repository.fullName);
    }
    for (const repository of props.savedRepositories ?? []) {
      if (!names.has(repository.repositoryId)) {
        names.set(repository.repositoryId, repository.fullName);
      }
    }
    const repositories = [...names].flatMap(([repositoryId, fullName]) => {
      const access = selected[repositoryId];
      return access ? [{ repositoryId, fullName, access }] : [];
    });
    if (await props.onSave(repositories, allAccess)) props.onOpenChange(false);
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Your GitHub</DialogTitle>
          <DialogDescription>
            Connected as @{props.login}. Choose the repos Opengeni may use as you.
          </DialogDescription>
        </DialogHeader>

        {props.allRepositoriesAvailable || props.allRepositoriesAccess ? (
          <div className="flex items-center gap-2">
            <Select
              value={allAccess ? "all" : "chosen"}
              disabled={props.busy}
              onChange={(event) =>
                setAllAccess(
                  event.target.value === "all" ? (props.allRepositoriesAccess ?? "write") : null,
                )
              }
              aria-label="Repositories Opengeni may use"
              className="h-9 flex-1 text-sm"
            >
              <option value="chosen">Choose repositories</option>
              <option value="all">All my repositories</option>
            </Select>
            {allAccess ? (
              <Select
                value={allAccess}
                disabled={props.busy}
                onChange={(event) =>
                  setAllAccess(event.target.value as PersonalGitHubRepositoryAccess)
                }
                aria-label="Access to all repositories"
                className="h-9 w-40 text-sm"
              >
                <option value="read">Read only</option>
                <option value="write">Read and write</option>
              </Select>
            ) : null}
          </div>
        ) : null}

        {allAccess ? null : (
          <>
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
                <p className="py-8 text-center text-sm text-fg-muted">
                  {props.loading || searching ? "Loading repositories…" : "No repositories found."}
                </p>
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
                            else
                              next[repository.repositoryId] = repositoryCanWrite ? "write" : "read";
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
          </>
        )}

        <p className="text-xs leading-5 text-fg-muted">
          {allAccess ? "Any repository you can access on GitHub. " : "Only these repositories. "}
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
