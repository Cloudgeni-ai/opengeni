import {
  CheckIcon,
  ChevronDownIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  Loader2Icon,
  LockIcon,
  PlusIcon,
  Settings2Icon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAppHost } from "../lib/app-host";
import { toast } from "../lib/toast";
import { REPOSITORY_PANEL_CLASS } from "./repository-picker-layout";
import {
  ComposerMenuHeader,
  ComposerMenuRowsSkeleton,
  ComposerMenuSwitch,
} from "../../ui/composer-menu";
import { MENU_BUTTON_CLASS, MENU_LABEL_CLASS, MENU_NOTE_CLASS } from "../../ui/menu-styles";

import {
  ManualRepositoryEditor,
  type ManualRepositoryAttachResult,
} from "./manual-repository-editor";
import { RepositoryRefInput } from "./repository-ref-input";
import { Button } from "../../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../../ui/dropdown-menu";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { MetaChip } from "../../ui/meta-chip";
import { SegmentedControl } from "../../ui/segmented-control";
import { userErrorText } from "../../ui/api-error";
import { ErrorText } from "../../ui/error-text";
import { repoCountLabel } from "../lib/format";
import { attachedManualRepositoryCount } from "../lib/manual-repositories";
import {
  gitHubRepositoryResource,
  isRepositoryResourceForGitHubRepo,
  sameRepositoryUri,
  type RepoDraft,
  type RepositoryGroup,
} from "../lib/session-tools";
import { cn } from "../lib/utils";
import type {
  GitHubAppSetupMode,
  GitHubBindingStatus,
  GitHubInstallationBinding,
  GitHubRepository,
  PersonalGitHubConnectionStatusResponse,
  PersonalGitHubRepositoryCatalogItem,
  ResourceRef,
} from "../types";

export function repositoryBindingPresentation(
  status: GitHubBindingStatus,
  installUrl: string | null,
  setupMode: GitHubAppSetupMode = "operator",
): {
  setupDescription: string;
  emptyDescription: string;
  connectUrl: string | null;
  connectLabel: string;
  healthy: boolean;
  canRefresh: boolean;
} {
  if (status === "bound") {
    return {
      setupDescription:
        setupMode === "platform"
          ? "This workspace is connected to Opengeni's managed GitHub App."
          : "This workspace has a live GitHub App binding with an explicit repository allowlist.",
      emptyDescription:
        "The Opengeni app is installed, but no repositories are shared with this workspace yet.",
      connectUrl: installUrl,
      connectLabel: "Install on another account",
      healthy: true,
      canRefresh: true,
    };
  }
  if (status === "unbound") {
    return {
      setupDescription:
        setupMode === "platform"
          ? "Install Opengeni on a GitHub account you own, or connect an existing installation."
          : "GitHub App server credentials are configured, but this workspace has no usable installation binding.",
      emptyDescription:
        setupMode === "platform"
          ? "Connect as the personal account owner or an organization owner. GitHub repository administrators and collaborators cannot connect an installation."
          : "GitHub App server credentials exist, but this workspace has no active installation binding. Connect as the personal owner or an organization owner; repository administrators and collaborators cannot bind.",
      connectUrl: installUrl,
      connectLabel: setupMode === "platform" ? "Install" : "Connect workspace App",
      healthy: false,
      canRefresh: false,
    };
  }
  return {
    setupDescription:
      setupMode === "platform"
        ? "GitHub is temporarily unavailable for this Opengeni deployment."
        : "Create a prefilled app, add the generated values to your .env, then restart the API and worker.",
    emptyDescription:
      setupMode === "platform"
        ? "GitHub integration is unavailable for this Opengeni deployment."
        : "GitHub App server credentials are not configured. App registration alone does not connect repositories.",
    connectUrl: null,
    connectLabel: "Connect GitHub",
    healthy: false,
    canRefresh: false,
  };
}

export type RepositoryContextPickerProps = {
  setupMode: GitHubAppSetupMode;
  configured: boolean;
  status: GitHubBindingStatus;
  installUrl: string | null;
  linkUrl: string | null;
  installations: GitHubInstallationBinding[];
  repositories: GitHubRepository[];
  personalGitHubStatus?: PersonalGitHubConnectionStatusResponse | null | undefined;
  personalGitHubRepositories?: PersonalGitHubRepositoryCatalogItem[] | undefined;
  selectedPersonalGitHubRepoIds?: Set<string> | undefined;
  selectedPersonalGitHubRepoRefs?: Record<string, string> | undefined;
  personalGitHubBusy?: boolean | undefined;
  onConnectPersonalGitHub?: (() => void) | undefined;
  onTogglePersonalGitHubRepo?: ((repo: PersonalGitHubRepositoryCatalogItem) => void) | undefined;
  onPersonalGitHubRefChange?: ((repositoryId: string, ref: string) => void) | undefined;
  /**
   * Finds more of the person's repositories on GitHub for a search; matches
   * arrive through `personalGitHubRepositories`.
   */
  onSearchPersonalGitHubRepositories?: ((query: string) => Promise<void>) | undefined;
  groups: RepositoryGroup[];
  selectedRepoIds: Set<number>;
  selectedRepoRefs: Record<number, string>;
  manualRepos: RepoDraft[];
  manualOpen: boolean;
  org: string;
  pending: boolean;
  repoBusy: boolean;
  /**
   * The workspace's GitHub status or repository list failed to load and no
   * earlier list is shown. The menu says so instead of offering setup.
   */
  githubLoadFailed?: boolean | undefined;
  /**
   * A later refresh failed while the earlier list is still shown. The menu
   * keeps the list and says it couldn't update it, with "Try again".
   */
  githubUpdateFailed?: boolean | undefined;
  githubAppBusy: boolean;
  /**
   * Reloads both catalogs now (a manager's reload also syncs from GitHub). The
   * list refreshes itself on open and after GitHub flows; this backs the
   * "Try again" shown after a failed load.
   */
  onRefresh: () => Promise<void>;
  /** Passive open refresh. Caller owns provider-sync permissions and throttling. */
  onOpenRefresh?: (() => Promise<void>) | undefined;
  /**
   * The person is leaving to change GitHub access (on GitHub or the GitHub
   * settings page). The caller refreshes both catalogs, unthrottled, once they
   * are back.
   */
  onLeaveForGitHub?: (() => void) | undefined;
  /** False when the current principal cannot read either repository catalog. */
  refreshAllowed?: boolean | undefined;
  onToggleRepo: (repo: GitHubRepository) => void;
  onRefChange: (repoId: number, ref: string) => void;
  onManualOpenChange: (open: boolean) => void;
  onManualAdd: () => void;
  onManualUpdate: (id: number, patch: Partial<RepoDraft>) => void;
  onManualRemove: (id: number) => void;
  onManualAttach?: ((repository: RepoDraft) => Promise<ManualRepositoryAttachResult>) | undefined;
  onLoadGitHubBranches?:
    | ((repository: GitHubRepository) => Promise<import("../types").GitHubRepositoryBranch[]>)
    | undefined;
  onLoadPersonalGitHubBranches?:
    | ((
        repository: PersonalGitHubRepositoryCatalogItem,
      ) => Promise<import("../types").GitHubRepositoryBranch[]>)
    | undefined;
  onOrgChange: (value: string) => void;
  onStartGitHubApp: () => void;
  /**
   * Starts workspace App setup. The link is minted on click: `installUrl` only
   * gates whether this principal may connect, because a page-load link expires.
   */
  onConnectWorkspaceApp: () => void;
  /** Repositories already mounted on an additive surface cannot be removed or retargeted. */
  lockedRepoIds?: ReadonlySet<number> | undefined;
  /** Opens the chooser for which personal repositories Opengeni may use. */
  personalGitHubManageUrl?: string | undefined;
  /**
   * The workspace's GitHub settings, where people manage both ways of
   * connecting (their own GitHub and the Opengeni app): repositories,
   * installations and unlinking. The picker links here once anything is connected.
   */
  githubSettingsUrl?: string | undefined;
  /** Personal repositories already mounted on an additive surface cannot be removed or retargeted. */
  lockedPersonalGitHubRepoIds?: ReadonlySet<string> | undefined;
  /** Manual rows already mounted on an additive surface are rendered read-only. */
  lockedManualRepoIds?: ReadonlySet<number> | undefined;
  /** Mounted personal sources may outlive their currently authorized catalog entry. */
  unavailableMountedRepositories?: ReadonlyArray<{ uri: string; ref: string }> | undefined;
  /**
   * Switching a mounted repository off asks to remove it from the chat. Without
   * it, mounted repositories stay locked.
   */
  onRemoveMountedRepository?: ((target: MountedRepositoryTarget) => void) | undefined;
  /** Inline validation for pending manual repository additions. */
  validationError?: string | null | undefined;
  /** New-chat route used to explain immutable mounted follow-up resources. */
  newChatUrl?: string | undefined;
  /** Optional back control when embedded in the mobile “+” drill-in. */
  leading?: ReactNode | undefined;
  /** Extra classes on the bar trigger (e.g. `max-sm:hidden` when opened from +). */
  triggerClassName?: string | undefined;
};

/** A mounted repository row the person switched off. */
export type MountedRepositoryTarget =
  | { kind: "app"; repository: GitHubRepository }
  | { kind: "personal"; repository: PersonalGitHubRepositoryCatalogItem }
  | { kind: "uri"; uri: string };

/** Shared picker body — desktop dropdown and mobile “+” drill-in. */
export function RepositoryContextMenuBody(props: RepositoryContextPickerProps) {
  const [search, setSearch] = useState("");
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const refreshedOnOpen = useRef(false);
  const openRefresh = useRef(props.onOpenRefresh);
  openRefresh.current = props.onOpenRefresh;
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => {
        if (!active || refreshedOnOpen.current || !openRefresh.current) return;
        refreshedOnOpen.current = true;
        return openRefresh.current();
      })
      .catch((error: unknown) => {
        if (active) setRefreshError(userErrorText(error));
      });
    return () => {
      active = false;
    };
  }, []);
  const [personalSearching, setPersonalSearching] = useState(false);
  const searchPersonal = useRef(props.onSearchPersonalGitHubRepositories);
  searchPersonal.current = props.onSearchPersonalGitHubRepositories;
  const personalSearchActive =
    props.personalGitHubStatus?.enabled === true &&
    props.personalGitHubStatus.connection?.status === "active" &&
    Boolean(props.onSearchPersonalGitHubRepositories);
  useEffect(() => {
    const needle = search.trim();
    if (!personalSearchActive || needle.length < 2) return;
    let active = true;
    const timer = setTimeout(() => {
      setPersonalSearching(true);
      void searchPersonal
        .current?.(needle)
        .catch(() => undefined)
        .finally(() => {
          if (active) setPersonalSearching(false);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
      setPersonalSearching(false);
    };
  }, [personalSearchActive, search]);
  const matchesSearch = (name: string) => name.toLowerCase().includes(search.trim().toLowerCase());
  const personalRepositories = (props.personalGitHubRepositories ?? []).filter(
    (repository) => repository.selectedAccess !== null,
  );
  const manualCount = attachedManualRepositoryCount(props.manualRepos);
  const hasRepos = props.repositories.length > 0;
  const bindingPresentation = repositoryBindingPresentation(
    props.status,
    props.installUrl,
    props.setupMode,
  );
  const loadFailed = props.githubLoadFailed === true && !hasRepos && !props.repoBusy;
  const updateFailed = props.githubUpdateFailed === true && !props.repoBusy && !refreshBusy;
  const canRefresh =
    props.refreshAllowed !== false &&
    (bindingPresentation.canRefresh || loadFailed || props.personalGitHubStatus?.enabled === true);
  async function refreshList() {
    if (!canRefresh || props.repoBusy || refreshBusy) return;
    setRefreshBusy(true);
    setRefreshError(null);
    try {
      await props.onRefresh();
    } catch (error) {
      setRefreshError(userErrorText(error));
    } finally {
      setRefreshBusy(false);
    }
  }

  const personalEnabled = props.personalGitHubStatus?.enabled === true;
  const personalActive =
    personalEnabled && props.personalGitHubStatus?.connection?.status === "active";
  const personalLogin = personalActive
    ? githubLoginLabel(props.personalGitHubStatus?.connection?.metadata.githubLogin)
    : null;
  const allRowGroups = repositoryPickerRowGroups(props.groups, personalRepositories);
  const rowGroups = allRowGroups.flatMap((group) => {
    const rows = group.rows.filter((row) => matchesSearch(row.fullName));
    return rows.length > 0 ? [{ ...group, rows }] : [];
  });
  const appBound = props.status === "bound";
  // Nothing to pick yet: the ways to get repositories are the main content.
  const onboarding = allRowGroups.length === 0 && !props.repoBusy && !loadFailed;
  // A hosted workspace without the app gets one plain prompt, not the binding note.
  const connectPrompt = onboarding && props.setupMode === "platform" && props.status === "unbound";
  // Account management (choosing repositories, installing on more accounts,
  // unlinking) lives on the GitHub settings page; the picker links there once
  // anything is connected.
  const manageVisible =
    Boolean(props.githubSettingsUrl) &&
    (personalActive || appBound || props.installations.length > 0 || loadFailed);

  const onboardingEntries: ReactNode[] = [];
  if (onboarding && personalEnabled) {
    onboardingEntries.push(
      <div key="personal" className="flex items-center justify-between gap-3 px-2.5 py-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-fg">Your GitHub</div>
          <div className={cn("mt-0.5 text-xs text-fg-subtle", personalActive && "truncate")}>
            {personalActive
              ? `${personalLogin} · ${repoCountLabel(personalRepositories.length)}`
              : "Work appears under your name."}
          </div>
        </div>
        {personalActive ? (
          props.personalGitHubManageUrl ? (
            <Button asChild variant="ghost" size="xs">
              <AppPageLink href={props.personalGitHubManageUrl} onClick={props.onLeaveForGitHub}>
                Choose repos
              </AppPageLink>
            </Button>
          ) : null
        ) : (
          <Button
            type="button"
            size="xs"
            onClick={() => {
              props.onLeaveForGitHub?.();
              props.onConnectPersonalGitHub?.();
            }}
            disabled={props.pending || props.personalGitHubBusy || !props.onConnectPersonalGitHub}
          >
            Connect
          </Button>
        )}
      </div>,
    );
  }
  const operatorSetup = props.setupMode === "operator" && !props.configured;
  // An operator without the app yet keeps Create app even once other repositories are listed.
  if (
    (onboarding && !appBound && (props.setupMode === "operator" || props.status === "unbound")) ||
    (operatorSetup && !loadFailed)
  ) {
    const connectable = Boolean(bindingPresentation.connectUrl);
    onboardingEntries.push(
      <div key="app" className="space-y-2 px-2.5 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg">Opengeni app</div>
            <div className="mt-0.5 text-xs leading-4.5 text-fg-subtle">
              {props.setupMode === "operator"
                ? bindingPresentation.setupDescription
                : connectable
                  ? "Work appears as the Opengeni bot, shared with the workspace."
                  : "A workspace admin can install it."}
            </div>
          </div>
          {connectable && !operatorSetup ? (
            <Button
              type="button"
              size="xs"
              className="shrink-0"
              // The connect dialog syncs the list itself when it completes.
              onClick={props.onConnectWorkspaceApp}
              disabled={props.pending}
            >
              {bindingPresentation.connectLabel}
            </Button>
          ) : null}
        </div>
        {operatorSetup ? (
          <div className="flex items-end gap-1.5">
            <div className="min-w-0 flex-1">
              <Label htmlFor="github-org-menu" className="text-2xs text-fg-subtle">
                Organization
              </Label>
              <Input
                id="github-org-menu"
                value={props.org}
                onChange={(event) => props.onOrgChange(event.target.value)}
                placeholder="Optional org login"
                disabled={props.githubAppBusy}
                className="mt-1 h-8 text-xs"
              />
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                props.onLeaveForGitHub?.();
                props.onStartGitHubApp();
              }}
              disabled={props.githubAppBusy}
              className="h-8 text-xs"
            >
              {props.githubAppBusy ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <GitPullRequestIcon className="size-3.5" />
              )}
              Create app
            </Button>
          </div>
        ) : null}
      </div>,
    );
  }

  return (
    <div onKeyDown={(event) => event.stopPropagation()} className="flex min-h-0 flex-1 flex-col">
      <ComposerMenuHeader title="Repositories" leading={props.leading} />

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain max-h-[min(calc(var(--radix-dropdown-menu-content-available-height,70vh)-3.5rem),620px)]">
        <div className="space-y-1">
          {personalSearchActive ||
          props.repositories.length + (props.personalGitHubRepositories?.length ?? 0) > 5 ? (
            <Input
              aria-label="Search repositories"
              placeholder="Search repositories…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-8 text-xs"
            />
          ) : null}
          {search.trim() &&
          !props.repositories.some((repo) => matchesSearch(repo.fullName)) &&
          !personalRepositories.some((repo) => matchesSearch(repo.fullName)) ? (
            <p className={MENU_NOTE_CLASS}>
              {personalSearching ? "Searching GitHub…" : "No repositories match your search."}
            </p>
          ) : null}
          {rowGroups.length > 0 ? (
            <section>
              {rowGroups.map((group) => (
                <div key={group.key} className="py-1">
                  <div className={cn(MENU_LABEL_CLASS, "truncate")}>{group.label}</div>
                  <div>
                    {group.rows.map((row) => (
                      <RepositoryPickerRowView key={row.key} row={row} picker={props} />
                    ))}
                  </div>
                </div>
              ))}
            </section>
          ) : null}
          {personalActive && props.personalGitHubBusy && personalRepositories.length === 0 ? (
            <div className={cn(MENU_NOTE_CLASS, "flex items-center gap-2")}>
              <Loader2Icon className="size-4 animate-spin" />
              Loading your repositories
            </div>
          ) : null}

          {hasRepos ? null : loadFailed ? (
            <div className="px-2.5 py-2" role="status">
              <p className="text-sm text-fg">Couldn't load GitHub</p>
              <p className="mt-0.5 text-xs leading-4.5 text-fg-muted">
                {canRefresh ? (
                  <RetryLink onClick={() => void refreshList()} disabled={refreshBusy} />
                ) : (
                  "Your repositories show here once it loads."
                )}
              </p>
            </div>
          ) : props.repoBusy ? (
            // First load only: rows that hold the menu's size. A refresh with
            // repositories already listed updates them in place, quietly.
            allRowGroups.length > 0 ? null : (
              <ComposerMenuRowsSkeleton rows={4} label="Loading repositories" />
            )
          ) : allRowGroups.length === 0 && !(personalActive && props.personalGitHubBusy) ? (
            connectPrompt ? (
              <p className="px-2.5 pt-2 pb-1 text-sm text-fg">
                Connect GitHub to pick repositories.
              </p>
            ) : (
              <div className="px-2.5 py-2">
                <p className="text-sm text-fg">No repositories connected</p>
                <p className="mt-0.5 text-xs leading-4.5 text-fg-muted">
                  {bindingPresentation.emptyDescription}
                </p>
              </div>
            )
          ) : null}

          {onboardingEntries.length > 0 ? (
            <div className="space-y-1">{onboardingEntries}</div>
          ) : null}

          {props.unavailableMountedRepositories?.map((repo) => (
            <div key={`${repo.uri}:${repo.ref}`} className="flex items-center gap-3 px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-fg" title={repo.uri}>
                  {repo.uri}
                </div>
                <div className="truncate text-xs text-fg-subtle">
                  {repo.ref} ·{" "}
                  {personalActive
                    ? "No longer shared"
                    : personalEnabled &&
                        props.personalGitHubStatus?.connection &&
                        !props.personalGitHubBusy
                      ? "Reconnect your GitHub"
                      : "Unavailable"}
                </div>
              </div>
              <MetaChip dot="idle" rounded="full">
                {props.onRemoveMountedRepository ? null : (
                  <LockIcon className="size-3" aria-hidden="true" />
                )}
                In chat
              </MetaChip>
              <ComposerMenuSwitch
                checked
                locked={!props.onRemoveMountedRepository}
                disabled={props.pending}
                label={`${repo.uri} in this chat`}
                onCheckedChange={() =>
                  props.onRemoveMountedRepository?.({ kind: "uri", uri: repo.uri })
                }
              />
            </div>
          ))}
          {props.manualRepos
            .filter((repo) => props.lockedManualRepoIds?.has(repo.id))
            .map((repo) => (
              <div key={repo.id} className="flex items-center gap-3 px-2.5 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-fg" title={repo.url}>
                    {repo.url}
                  </div>
                  <div className="truncate text-xs text-fg-subtle">{repo.ref}</div>
                </div>
                <MetaChip dot="idle" rounded="full">
                  {props.onRemoveMountedRepository ? null : (
                    <LockIcon className="size-3" aria-hidden="true" />
                  )}
                  In chat
                </MetaChip>
                <ComposerMenuSwitch
                  checked
                  locked={!props.onRemoveMountedRepository}
                  disabled={props.pending}
                  label={`${repo.url} in this chat`}
                  onCheckedChange={() =>
                    props.onRemoveMountedRepository?.({ kind: "uri", uri: repo.url })
                  }
                />
              </div>
            ))}

          {props.manualRepos.length === 0 ? (
            <button
              type="button"
              onClick={props.onManualAdd}
              disabled={props.pending}
              className={MENU_BUTTON_CLASS}
            >
              <PlusIcon />
              Add repository URL
            </button>
          ) : (
            <Collapsible open={props.manualOpen} onOpenChange={props.onManualOpenChange}>
              <div className="border-t border-border/60 pt-1">
                <div className="flex items-center justify-between gap-2 px-2.5 py-1">
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-[10px] text-left text-sm text-fg pointer-coarse:min-h-11"
                    >
                      <ChevronDownIcon
                        className={cn(
                          "size-3.5 shrink-0 text-fg-subtle transition-transform",
                          props.manualOpen && "rotate-180",
                        )}
                      />
                      <span className="truncate">Add repository URL</span>
                      {manualCount > 0 ? <MetaChip rounded="full">{manualCount}</MetaChip> : null}
                    </button>
                  </CollapsibleTrigger>
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

                <CollapsibleContent>
                  <div className="space-y-2 border-t border-border p-3">
                    {props.manualRepos.every((repo) => props.lockedManualRepoIds?.has(repo.id)) ? (
                      <p className="text-xs leading-5 text-fg-muted">
                        Public repositories only. Private ones come from your GitHub or the Opengeni
                        app.
                      </p>
                    ) : (
                      props.manualRepos
                        .filter((repo) => !props.lockedManualRepoIds?.has(repo.id))
                        .map((repo) => (
                          <ManualRepositoryEditor
                            key={repo.id}
                            repository={repo}
                            mounted={props.lockedManualRepoIds?.has(repo.id) === true}
                            pending={props.pending}
                            onUpdate={(patch) => props.onManualUpdate(repo.id, patch)}
                            onRemove={() => props.onManualRemove(repo.id)}
                            onAttach={
                              props.onManualAttach ??
                              (async () => {
                                throw new Error("Repository attachment is unavailable.");
                              })
                            }
                          />
                        ))
                    )}
                    {props.validationError ? (
                      <p className="text-xs leading-5 text-status-failed" role="alert">
                        {props.validationError}
                      </p>
                    ) : null}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          )}
          {/* The list refreshes itself on open and after GitHub flows; only a failure offers a retry. */}
          {(refreshError || updateFailed) && !loadFailed ? (
            <p className="px-2.5 text-xs text-status-failed" role="alert">
              Couldn't update the list.
              {refreshError ? (
                <>
                  {" "}
                  <ErrorText>{refreshError}</ErrorText>
                </>
              ) : null}
              {canRefresh ? (
                <>
                  {" "}
                  <RetryLink onClick={() => void refreshList()} disabled={refreshBusy} />
                </>
              ) : null}
            </p>
          ) : null}
          {manageVisible && props.githubSettingsUrl ? (
            <div className="border-t border-border/60 pt-1">
              <AppPageLink
                href={props.githubSettingsUrl}
                className={MENU_BUTTON_CLASS}
                onClick={props.onLeaveForGitHub}
              >
                <Settings2Icon />
                Manage GitHub access
              </AppPageLink>
            </div>
          ) : null}
          {props.newChatUrl &&
          (props.lockedRepoIds?.size ?? 0) +
            (props.lockedPersonalGitHubRepoIds?.size ?? 0) +
            (props.lockedManualRepoIds?.size ?? 0) >
            0 ? (
            <p className="px-2.5 text-xs leading-4.5 text-fg-muted">
              To change the branch of a repository already in this chat,{" "}
              <AppPageLink href={props.newChatUrl} className="og-link">
                start a new chat
              </AppPageLink>
              .
            </p>
          ) : null}
          {props.validationError && (!props.manualOpen || props.manualRepos.length === 0) ? (
            <p className="px-2.5 text-xs text-status-failed" role="alert">
              {props.validationError}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** One repository the picker can select, through the workspace App, your GitHub, or both. */
export type RepositoryPickerRow = {
  key: string;
  fullName: string;
  name: string;
  private: boolean;
  app: GitHubRepository | null;
  personal: PersonalGitHubRepositoryCatalogItem | null;
};

export type RepositoryPickerRowGroup = {
  key: string;
  label: string;
  rows: RepositoryPickerRow[];
};

function repositoryOwner(fullName: string): string {
  return fullName.split("/")[0] ?? fullName;
}

/**
 * Merges App and personal catalogs into one row per repository, grouped by
 * owner. App installations keep their order; a repository reachable both ways
 * is one row with both authorities.
 */
export function repositoryPickerRowGroups(
  groups: readonly RepositoryGroup[],
  personalRepositories: readonly PersonalGitHubRepositoryCatalogItem[],
): RepositoryPickerRowGroup[] {
  const ordered: RepositoryPickerRowGroup[] = [];
  const byOwner = new Map<string, RepositoryPickerRowGroup>();
  const byRepository = new Map<string, RepositoryPickerRow>();
  const groupFor = (label: string) => {
    const key = label.toLowerCase();
    let group = byOwner.get(key);
    if (!group) {
      group = { key, label, rows: [] };
      byOwner.set(key, group);
      ordered.push(group);
    }
    return group;
  };
  for (const group of groups) {
    for (const repo of group.repositories) {
      const key = repo.fullName.toLowerCase();
      if (byRepository.has(key)) continue;
      const row: RepositoryPickerRow = {
        key,
        fullName: repo.fullName,
        name: repo.name,
        private: repo.private,
        app: repo,
        personal: null,
      };
      byRepository.set(key, row);
      groupFor(repositoryOwner(repo.fullName)).rows.push(row);
    }
  }
  for (const repo of personalRepositories) {
    if (repo.selectedAccess === null) continue;
    const key = repo.fullName.toLowerCase();
    const existing = byRepository.get(key);
    if (existing) {
      existing.personal ??= repo;
      continue;
    }
    const row: RepositoryPickerRow = {
      key,
      fullName: repo.fullName,
      name: repo.fullName.slice(repositoryOwner(repo.fullName).length + 1) || repo.fullName,
      private: repo.private,
      app: null,
      personal: repo,
    };
    byRepository.set(key, row);
    groupFor(repositoryOwner(repo.fullName)).rows.push(row);
  }
  return ordered;
}

/**
 * Which identity a new selection acts as: you when your GitHub can write to
 * the repository (or is the only way to reach it), otherwise the workspace App.
 */
export function defaultRepositoryIdentity(row: RepositoryPickerRow): "personal" | "app" {
  if (!row.personal) return "app";
  if (!row.app) return "personal";
  return row.personal.selectedAccess === "write" ? "personal" : "app";
}

/** Inline retry after a failed load or background update. */
function RetryLink(props: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      className="og-link disabled:opacity-60"
      onClick={props.onClick}
      disabled={props.disabled}
    >
      Try again
    </button>
  );
}

/**
 * A link to another app page. Goes through the host's navigation, so an
 * embedded session UI opens it beside the host page instead of resolving it
 * against the host's origin; plain anchor when no navigation is configured.
 */
function AppPageLink(props: {
  href: string;
  className?: string | undefined;
  onClick?: (() => void) | undefined;
  children: ReactNode;
}) {
  const HostLink = useAppHost().navigation?.Link;
  if (!HostLink) {
    return (
      <a href={props.href} className={props.className} onClick={props.onClick}>
        {props.children}
      </a>
    );
  }
  return (
    <HostLink href={props.href} className={props.className} onClick={props.onClick}>
      {props.children}
    </HostLink>
  );
}

function githubLoginLabel(login: unknown): string {
  return typeof login === "string" && login.length > 0 ? `@${login}` : "Connected";
}

function RepositoryPickerRowView(props: {
  row: RepositoryPickerRow;
  picker: RepositoryContextPickerProps;
}) {
  const { row, picker } = props;
  const { app, personal } = row;
  const canUsePersonal = Boolean(personal && picker.onTogglePersonalGitHubRepo);
  const appLocked = app !== null && picker.lockedRepoIds?.has(app.id) === true;
  const personalLocked =
    personal !== null && picker.lockedPersonalGitHubRepoIds?.has(personal.repositoryId) === true;
  const appSelected = app !== null && picker.selectedRepoIds.has(app.id);
  const personalSelected =
    personal !== null && picker.selectedPersonalGitHubRepoIds?.has(personal.repositoryId) === true;
  const locked = appLocked || personalLocked;
  const checked = locked || appSelected || personalSelected;
  const actingAs: "personal" | "app" =
    personalLocked || personalSelected
      ? "personal"
      : appLocked || appSelected
        ? "app"
        : !app
          ? "personal"
          : canUsePersonal
            ? defaultRepositoryIdentity(row)
            : "app";
  const ref =
    actingAs === "personal" && personal
      ? (picker.selectedPersonalGitHubRepoRefs?.[personal.repositoryId] ?? personal.defaultBranch)
      : app
        ? (picker.selectedRepoRefs[app.id] ?? app.defaultBranch)
        : (personal?.defaultBranch ?? "");
  const defaultRef =
    actingAs === "personal" && personal ? personal.defaultBranch : (app?.defaultBranch ?? "");
  const personalBusy = picker.personalGitHubBusy === true;

  function select(identity: "personal" | "app") {
    if (identity === "personal" && personal) picker.onTogglePersonalGitHubRepo?.(personal);
    else if (app) picker.onToggleRepo(app);
  }
  function toggle() {
    if (locked) {
      if (personalLocked && personal) {
        picker.onRemoveMountedRepository?.({ kind: "personal", repository: personal });
      } else if (app) {
        picker.onRemoveMountedRepository?.({ kind: "app", repository: app });
      }
      return;
    }
    if (personalSelected && personal) picker.onTogglePersonalGitHubRepo?.(personal);
    else if (appSelected && app) picker.onToggleRepo(app);
    else select(actingAs);
  }
  // The new identity's selection replaces the other one; it keeps the ref.
  function switchIdentity(identity: "personal" | "app") {
    if (identity === actingAs || !app || !personal) return;
    if (identity === "personal") picker.onPersonalGitHubRefChange?.(personal.repositoryId, ref);
    else picker.onRefChange(app.id, ref);
    select(identity);
  }

  const rawLogin = picker.personalGitHubStatus?.connection?.metadata.githubLogin;
  const you = typeof rawLogin === "string" && rawLogin.length > 0 ? `You (@${rawLogin})` : "You";
  const showIdentityChoice = checked && !locked && app !== null && canUsePersonal;
  // With your GitHub connected there are two identities, so a selected
  // repository always says which one it works as. Without it there is only
  // the app, and nothing to explain.
  const showIdentity =
    checked &&
    !locked &&
    picker.personalGitHubStatus?.enabled === true &&
    picker.personalGitHubStatus.connection?.status === "active";
  const readOnly = actingAs === "personal" && personal?.selectedAccess === "read";
  // A selected row shows its branch in the field below; the subtitle would repeat it.
  const editing = checked && !locked;
  return (
    <div className="rounded-[10px] px-2.5 py-2 transition-colors hover:bg-hover">
      <div className="flex w-full items-center gap-3 text-left">
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-fg">{row.name}</span>
            {row.private ? <LockIcon className="size-3 shrink-0 text-fg-subtle" /> : null}
          </span>
          {editing && !readOnly ? null : (
            <span className="mt-0.5 block truncate text-xs text-fg-subtle">
              {editing ? "Read only" : readOnly ? `${ref} · Read only` : ref}
            </span>
          )}
        </span>
        {locked ? (
          <MetaChip dot="idle" rounded="full">
            {picker.onRemoveMountedRepository ? null : (
              <LockIcon className="size-3" aria-hidden="true" />
            )}
            In chat
          </MetaChip>
        ) : null}
        <ComposerMenuSwitch
          checked={checked}
          locked={locked && !picker.onRemoveMountedRepository}
          disabled={
            picker.pending ||
            (!locked &&
              actingAs === "personal" &&
              (personalBusy || !picker.onTogglePersonalGitHubRepo))
          }
          onCheckedChange={toggle}
          label={
            locked
              ? personalLocked
                ? `${row.fullName} in this chat as you`
                : `${row.fullName} in this chat`
              : `Select ${row.fullName}`
          }
        />
      </div>
      {checked && !locked ? (
        <div className="mt-1 space-y-1.5">
          <RepositoryRefInput
            value={ref}
            defaultRef={defaultRef}
            label={`${row.fullName} ref`}
            compact
            onChange={(value) => {
              if (actingAs === "personal" && personal) {
                picker.onPersonalGitHubRefChange?.(personal.repositoryId, value);
              } else if (app) {
                picker.onRefChange(app.id, value);
              }
            }}
            disabled={picker.pending}
            loadBranches={
              actingAs === "personal" && personal
                ? picker.onLoadPersonalGitHubBranches?.bind(null, personal)
                : app
                  ? picker.onLoadGitHubBranches?.bind(null, app)
                  : undefined
            }
          />
          {showIdentityChoice ? (
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-xs text-fg-subtle">Acts as</span>
              <SegmentedControl
                size="sm"
                aria-label={`${row.fullName} acts as`}
                value={actingAs}
                disabled={picker.pending || personalBusy}
                onValueChange={switchIdentity}
                options={[
                  { value: "personal", label: you },
                  { value: "app", label: "Opengeni app" },
                ]}
              />
            </div>
          ) : showIdentity ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="shrink-0 text-fg-subtle">Acts as</span>
              <span className="min-w-0 truncate text-fg-muted">
                {actingAs === "personal" ? you : "Opengeni app"}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function RepositoryContextPicker(props: RepositoryContextPickerProps) {
  const selectedInstalledCount = props.selectedRepoIds.size;
  const selectedPersonalCount = props.selectedPersonalGitHubRepoIds?.size ?? 0;
  const manualCount = attachedManualRepositoryCount(props.manualRepos);
  const selectedCount = selectedInstalledCount + selectedPersonalCount + manualCount;
  const bindingPresentation = repositoryBindingPresentation(
    props.status,
    props.installUrl,
    props.setupMode,
  );
  const personalGitHubActive = props.personalGitHubStatus?.connection?.status === "active";
  const selectedInstalled = props.repositories.filter((repo) => props.selectedRepoIds.has(repo.id));
  const selectedManual = props.manualRepos.filter(
    (repo) => repo.attached !== false && repo.url.trim().length > 0,
  );
  const selectedNames = [
    ...selectedInstalled.map((repo) => repo.fullName),
    ...selectedManual.map((repo) => repo.url.trim()),
    ...(props.personalGitHubRepositories ?? [])
      .filter((repo) => props.selectedPersonalGitHubRepoIds?.has(repo.repositoryId))
      .map((repo) => repo.fullName),
  ];
  const selectedLabel =
    selectedCount === 1 ? (selectedNames[0] ?? repoCountLabel(1)) : repoCountLabel(selectedCount);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.pending}
          aria-label={
            selectedCount > 0
              ? `Repository context: ${selectedNames.join(", ") || selectedLabel}`
              : "Repository context"
          }
          title={selectedCount > 0 ? selectedNames.join(", ") || selectedLabel : "Repositories"}
          className={cn(
            "h-8 max-w-[13rem] gap-1.5 rounded-full border border-transparent px-2.5 text-xs",
            "text-fg-muted hover:border-border hover:bg-surface-2 hover:text-fg",
            selectedCount > 0 && "border-brand/35 bg-brand/10 text-fg",
            props.triggerClassName,
          )}
        >
          <GitBranchIcon className="size-3.5" />
          <span className="truncate">{selectedCount > 0 ? selectedLabel : "Repos"}</span>
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              (bindingPresentation.healthy && props.githubLoadFailed !== true) ||
                personalGitHubActive
                ? "bg-status-idle"
                : "bg-status-waiting",
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
        className={REPOSITORY_PANEL_CLASS}
      >
        <RepositoryContextMenuBody {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ScheduledTaskRepositoryPicker(props: {
  status: GitHubBindingStatus;
  repositories: GitHubRepository[];
  groups: RepositoryGroup[];
  resources: ResourceRef[];
  busy: boolean;
  repoBusy: boolean;
  onResourcesChange: (resources: ResourceRef[]) => void;
}) {
  const repositoryResources = props.resources.filter(
    (resource): resource is Extract<ResourceRef, { kind: "repository" }> =>
      resource.kind === "repository",
  );
  const fileResources = props.resources.filter((resource) => resource.kind === "file");
  const preservedRepositoryResources = repositoryResources.filter(
    (resource) =>
      !props.repositories.some((repo) => isRepositoryResourceForGitHubRepo(resource, repo)),
  );
  function toggleRepo(repo: GitHubRepository) {
    const existing = props.resources.find(
      (resource) =>
        resource.kind === "repository" && isRepositoryResourceForGitHubRepo(resource, repo),
    );
    if (existing) {
      props.onResourcesChange(props.resources.filter((resource) => resource !== existing));
      return;
    }
    try {
      const nextResource = gitHubRepositoryResource(repo, repo.defaultBranch);
      props.onResourcesChange([
        ...props.resources.filter((resource) => !sameRepositoryUri(resource, nextResource.uri)),
        nextResource,
      ]);
    } catch (error) {
      toast.error("Couldn't select the repository", { description: userErrorText(error) });
    }
  }

  function updateRef(repo: GitHubRepository, ref: string) {
    props.onResourcesChange(
      props.resources.map((resource) => {
        if (resource.kind !== "repository" || !isRepositoryResourceForGitHubRepo(resource, repo)) {
          return resource;
        }
        return { ...resource, ref };
      }),
    );
  }

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-bg/25">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div>
          <div className="text-xs font-medium text-fg">Repositories</div>
          <div className="mt-0.5 text-2xs text-fg-subtle">
            {repoCountLabel(repositoryResources.length)} attached to this task
          </div>
        </div>
      </div>

      {props.status !== "bound" ? (
        <div className="p-3 text-xs leading-5 text-fg-muted">
          {props.status === "disabled"
            ? "GitHub App server credentials are not configured."
            : "GitHub App credentials exist, but this workspace has no active installation binding."}
        </div>
      ) : props.repoBusy ? (
        <div className="flex items-center gap-2 p-3 text-xs text-fg-muted">
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading repositories
        </div>
      ) : props.repositories.length === 0 ? (
        <div className="p-3 text-xs leading-5 text-fg-muted">
          The active binding currently shares no explicitly allowed repositories.
        </div>
      ) : (
        <div className="max-h-72 overflow-auto">
          {props.groups.map((group) => (
            <div key={group.installationId} className="border-b border-border last:border-b-0">
              <div className="flex items-center justify-between gap-3 bg-surface/45 px-3 py-1.5">
                <div className="min-w-0 truncate text-2xs font-medium text-fg-muted">
                  {group.label}
                </div>
                <div className="shrink-0 text-2xs uppercase tracking-wide text-fg-subtle">
                  {group.repositories.length} repos
                </div>
              </div>
              <div className="divide-y divide-border/70">
                {group.repositories.map((repo) => {
                  const resource = repositoryResources.find((item) =>
                    isRepositoryResourceForGitHubRepo(item, repo),
                  );
                  const checked = Boolean(resource);
                  return (
                    <div
                      key={`${repo.installationId}:${repo.id}`}
                      className="px-2 py-2 transition-colors hover:bg-hover"
                    >
                      <button
                        type="button"
                        onClick={() => toggleRepo(repo)}
                        disabled={props.busy}
                        aria-pressed={checked}
                        aria-label={`Select ${repo.fullName} for the automation`}
                        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md text-left outline-hidden"
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
                            <span className="truncate text-xs font-medium text-fg">
                              {repo.fullName}
                            </span>
                            {repo.private ? (
                              <LockIcon className="size-3 shrink-0 text-fg-subtle" />
                            ) : null}
                          </span>
                          <span className="mt-0.5 block truncate text-2xs text-fg-subtle">
                            default {repo.defaultBranch}
                          </span>
                        </span>
                        {checked ? (
                          <MetaChip dot="idle" rounded="full">
                            Selected
                          </MetaChip>
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
                            aria-label={`${repo.fullName} branch or ref for the automation`}
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
          Preserving {preservedRepositoryResources.length} manual repository resource
          {preservedRepositoryResources.length === 1 ? "" : "s"}
          {fileResources.length > 0
            ? ` and ${fileResources.length} file resource${fileResources.length === 1 ? "" : "s"}`
            : ""}
          .
        </div>
      ) : null}
    </section>
  );
}
