import type { AuthNeededItem } from "@opengeni/react";
import type { SendMessageInput } from "@opengeni/sdk";
import { ArrowUpRightIcon, BookMarkedIcon, CheckIcon, Loader2Icon, LockIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ListRow, ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { RowButton } from "@/components/ui/page-actions";
import { userErrorText } from "@/lib/api-error";
import { hasWorkspacePermission } from "@/lib/permissions";
import { repositoryDisplayName } from "@/lib/session-tools";
import { cn } from "@/lib/utils";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import type { GitHubAppInfo, GitHubRepository, ResourceRef } from "@/types";
import { capabilityLogoSource } from "./capability-logo-source";
import { SessionCapabilityFrame } from "./session-capability-frame";
import {
  GITHUB_CARD_MORE_SIZE,
  GITHUB_CARD_PAGE_SIZE,
  GITHUB_CARD_SEARCH_THRESHOLD,
  gitHubRepositoryChatState,
  matchesRepositorySearch,
  orderRepositoriesForChat,
  repositoryUseMessage,
  revokedGitHubRepositoryResources,
  usingRepositoriesLabel,
  type ChatSendContext,
  type GitHubRepositoryChatState,
} from "./session-github-repositories";

type RepositoryResource = Extract<ResourceRef, { kind: "repository" }>;

/** Refresh on return to the tab: quickly while setup is pending, rarely after. */
const AWAITING_REFRESH_MS = 3_000;
const SETTLED_REFRESH_MS = 60_000;
/** A trip to GitHub from this card stays "pending" this long. */
const AWAITING_GITHUB_MS = 15 * 60_000;
const lastForegroundRefresh = new Map<string, number>();

export type SessionGitHubCapabilityCardProps = {
  item: AuthNeededItem;
  workspaceId: string;
  sessionId: string;
  /** The chat's mounted resources; repository rows are additive and immutable. */
  resources?: readonly ResourceRef[] | undefined;
  /** What a composer Send would carry now, so this Send follows the same rules. */
  sendContext?: (() => ChatSendContext) | undefined;
  /** Re-read the session after a human attach or setup lands. */
  onConfigured?: (() => Promise<void>) | undefined;
};

/**
 * The GitHub App card in a conversation. Connecting is the workspace's GitHub
 * App binding; using a repository in this chat is an ordinary human message
 * that carries the repository resource, the same request the composer
 * repository picker sends. The agent can request this card but never attach.
 */
export function SessionGitHubCapabilityCard({
  item,
  workspaceId,
  sessionId,
  resources,
  sendContext,
  onConfigured,
}: SessionGitHubCapabilityCardProps) {
  const context = useAppContext();
  const refreshGitHub = context.refreshGitHub;
  const recommendation = item.capability!;
  // A status read by Connect wins until the shared workspace status changes.
  const [observed, setObserved] = useState<{
    status: GitHubAppInfo;
    over: GitHubAppInfo | null;
  } | null>(null);
  const status =
    observed && observed.over === context.githubStatus ? observed.status : context.githubStatus;
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const inFlight = useRef(false);
  const requestSequence = useRef(0);
  const active = useRef(true);
  // When this card last sent the person to GitHub, so the return refreshes promptly.
  const sentToGitHubAt = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const bound = status?.status === "bound";
  const accessKnown = context.accessContext !== null && context.accessContext !== undefined;
  const can = (permission: string) =>
    !accessKnown || hasWorkspacePermission(context.accessContext, workspaceId, permission);
  const canUseGitHub = can("github:use");
  const canMessage = can("sessions:control");
  // Only the server mints the signed connect link, and only for a principal
  // that may manage this workspace's GitHub App.
  const canManage = Boolean(status?.linkUrl);
  const personal = isPersonalWorkspace(
    context.workspaces?.find((entry) => entry.id === workspaceId) ?? null,
    null,
  );

  // Re-sync from GitHub only while a connect or repository change is pending
  // (the composer picker's explicit refresh); otherwise re-read stored rows.
  const canSyncGitHub = can("github:manage");
  const awaitingChange = !bound || context.githubRepos.length === 0;
  const repoBusy = context.repoBusy;
  useEffect(() => {
    if (!canUseGitHub) return;
    const onForeground = () => {
      if (document.visibilityState === "hidden" || repoBusy) return;
      const now = Date.now();
      const awaiting = awaitingChange || now - sentToGitHubAt.current < AWAITING_GITHUB_MS;
      const interval = awaiting ? AWAITING_REFRESH_MS : SETTLED_REFRESH_MS;
      if (now - (lastForegroundRefresh.get(workspaceId) ?? 0) < interval) return;
      lastForegroundRefresh.set(workspaceId, now);
      // Another tab or popup may have connected GitHub or changed the
      // repositories it shares. A failed refresh keeps the last snapshot.
      void refreshGitHub(workspaceId, undefined, { sync: awaiting && canSyncGitHub }).catch(
        () => {},
      );
    };
    window.addEventListener("focus", onForeground);
    document.addEventListener("visibilitychange", onForeground);
    return () => {
      window.removeEventListener("focus", onForeground);
      document.removeEventListener("visibilitychange", onForeground);
    };
  }, [awaitingChange, canSyncGitHub, canUseGitHub, refreshGitHub, repoBusy, workspaceId]);

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || !inFlight.current) return;
      // A cancelled authorization can restore this exact React tree from the
      // back/forward cache. Its prior request must not navigate or settle a
      // newer attempt after the card becomes usable again.
      requestSequence.current += 1;
      inFlight.current = false;
      setBusy(false);
      void refreshGitHub(workspaceId);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [refreshGitHub, workspaceId]);

  async function connect() {
    if (inFlight.current) return;
    const sequence = ++requestSequence.current;
    inFlight.current = true;
    setBusy(true);
    setConnectError(null);
    let navigating = false;
    try {
      const next = await context.client.getGitHubApp(workspaceId, {
        returnPath: `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
      });
      if (!active.current || sequence !== requestSequence.current) return;
      if (next.status === "bound") {
        setObserved({ status: next, over: context.githubStatus });
        void context.refreshGitHub(workspaceId);
        return;
      }
      if (!next.linkUrl)
        throw new Error(
          next.configured
            ? "Your account cannot manage this workspace's GitHub connection."
            : "GitHub is not configured on this deployment.",
        );
      navigating = true;
      sentToGitHubAt.current = Date.now();
      window.location.assign(next.linkUrl);
    } catch (failure) {
      navigating = false;
      if (active.current && sequence === requestSequence.current) {
        setConnectError(`Couldn't start GitHub setup. ${userErrorText(failure, "Try again.")}`);
        setExpanded(true);
      }
    } finally {
      if (sequence === requestSequence.current && !navigating) {
        inFlight.current = false;
        if (active.current) setBusy(false);
      }
    }
  }

  const catalogItem = context.workspaceCapabilityCatalog.find(
    (entry) => entry.id === recommendation.id,
  );
  const logo = capabilityLogoSource(
    catalogItem ?? { id: recommendation.id, logoAssetPath: null },
    (path) => context.client.catalogAssetUrl(path),
  );

  const chooser = useRepositoryChooser({
    status,
    workspaceId,
    sessionId,
    resources,
    sendContext,
    onConfigured,
    cardRef,
    onOpenedGitHub: () => {
      sentToGitHubAt.current = Date.now();
    },
  });

  const unavailable = !bound
    ? !canUseGitHub
      ? "You don't have access to this workspace's GitHub connection."
      : status?.configured === false
        ? status.setupMode === "platform"
          ? "GitHub isn't available on this deployment right now."
          : "GitHub isn't set up on this deployment yet."
        : status && status.linkUrl === null
          ? "Only workspace admins can connect GitHub."
          : null
    : null;
  const unavailableNote = !bound
    ? !canUseGitHub
      ? "Ask a workspace admin for GitHub access."
      : status?.configured === false
        ? status.setupMode === "platform"
          ? "Try again later, or use a public repository URL from the composer."
          : "An operator adds the GitHub App settings to the API and worker. This card updates when GitHub is connected."
        : status && status.linkUrl === null
          ? "Ask a workspace admin to connect GitHub. This card updates when they do."
          : null
    : null;

  return (
    <SessionCapabilityFrame
      name={catalogItem?.name ?? recommendation.name}
      subtitle={catalogItem ? (catalogItem.providerDomain ?? "") : item.providerDomain}
      logo={logo}
      typeLabel="API"
      description={catalogItem?.description || recommendation.rationale}
      skill={false}
      expanded={expanded}
      complete={bound}
      completeLabel={
        chooser.statusLabel ??
        (personal ? "Connected to your Personal workspace" : "Connected to this workspace")
      }
      actionLabel={busy ? "Opening GitHub…" : `Connect ${catalogItem?.name ?? recommendation.name}`}
      actionUnavailable={unavailable}
      opensDialog={false}
      note={
        unavailableNote ??
        "Choose which account and repositories this workspace can access on GitHub."
      }
      onOpen={() => void connect()}
      onClose={() => setExpanded(false)}
      busy={busy}
      opener={opener}
      cardRef={cardRef}
      details={
        bound ? (
          <GitHubRepositoryPanel
            chooser={chooser}
            canMessage={canMessage}
            canManage={canManage}
            personal={personal}
          />
        ) : null
      }
    >
      <div className="space-y-3 p-6 sm:p-8">
        <p className="text-xs leading-[1.7] text-fg-muted">
          Choose the account and repositories to share with this workspace on GitHub, then return to
          this conversation.
        </p>
        {connectError ? <Notice tone="failed">{connectError}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setExpanded(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void connect()}>
            {busy ? <Loader2Icon className="animate-spin" /> : null}Try again
          </Button>
        </div>
      </div>
    </SessionCapabilityFrame>
  );
}

type RepositoryRow = {
  repository: GitHubRepository;
  state: GitHubRepositoryChatState;
};

type RepositoryChooser = ReturnType<typeof useRepositoryChooser>;

function useRepositoryChooser({
  status,
  workspaceId,
  sessionId,
  resources,
  sendContext,
  onConfigured,
  cardRef,
  onOpenedGitHub,
}: {
  status: GitHubAppInfo | null;
  workspaceId: string;
  sessionId: string;
  resources: readonly ResourceRef[] | undefined;
  sendContext: (() => ChatSendContext) | undefined;
  onConfigured: (() => Promise<void>) | undefined;
  cardRef: RefObject<HTMLElement | null>;
  onOpenedGitHub: () => void;
}) {
  const context = useAppContext();
  const repositories = context.githubRepos;
  const [optimistic, setOptimistic] = useState<RepositoryResource[]>([]);
  const [attaching, setAttaching] = useState<number | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  // What happened to the last accepted message, in words for the live region.
  const [outcome, setOutcome] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [openingInstallation, setOpeningInstallation] = useState<number | null>(null);
  // One exact request per repository until it is accepted: a retry after an
  // unknown outcome resends the same input under the same idempotency key.
  const pendingInputs = useRef(new Map<number, SendMessageInput & { clientEventId: string }>());
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Accepted attaches show at once; the re-read session replaces them.
  const mounted = useMemo(() => {
    const durable = [...(resources ?? [])];
    return [
      ...durable,
      ...optimistic.filter(
        (pending) =>
          !durable.some(
            (resource) =>
              resource.kind === "repository" &&
              resource.githubRepositoryId === pending.githubRepositoryId &&
              resource.githubInstallationId === pending.githubInstallationId,
          ),
      ),
    ];
  }, [optimistic, resources]);
  const accountLabel = useCallback(
    (installationId: number) =>
      status?.installations.find((installation) => installation.installationId === installationId)
        ?.accountLogin ?? "another GitHub account",
    [status],
  );
  // Rows already in the chat when the card appeared lead; a repository used
  // from this card stays where it was clicked instead of jumping to the top.
  const [leading] = useState(
    () =>
      new Set(
        (resources ?? []).flatMap((resource) =>
          resource.kind === "repository" && resource.githubRepositoryId !== undefined
            ? [`${resource.githubInstallationId}:${resource.githubRepositoryId}`]
            : [],
        ),
      ),
  );
  const rows: RepositoryRow[] = useMemo(() => {
    const states = new Map(
      repositories.map((repository) => [
        repository.id,
        gitHubRepositoryChatState(repository, mounted, accountLabel, repositories),
      ]),
    );
    return orderRepositoriesForChat(repositories, (repository) =>
      leading.has(`${repository.installationId}:${repository.id}`),
    ).map((repository) => ({ repository, state: states.get(repository.id)! }));
  }, [accountLabel, leading, mounted, repositories]);
  // A catalog mid-refresh is unknown, never proof that access was removed.
  const catalogSettled = context.githubCatalogReady && !context.repoBusy;
  const revoked = useMemo(
    () => revokedGitHubRepositoryResources(mounted, repositories, catalogSettled),
    [catalogSettled, mounted, repositories],
  );
  const attachedNames = rows
    .filter((row) => row.state.kind === "attached")
    .map((row) => row.repository.fullName);

  async function attach(
    repository: GitHubRepository,
    resource: RepositoryResource,
    confirmed = false,
  ) {
    if (inFlight.current) return;
    setAttachError(null);
    const chat = sendContext?.() ?? { blocked: null, awaitingHuman: false, extras: {} };
    if (chat.blocked) {
      setAttachError(chat.blocked);
      return;
    }
    // Like a composer Send, this replaces a request the chat is waiting on.
    if (chat.awaitingHuman && !confirmed) {
      setConfirming(repository.id);
      return;
    }
    setConfirming(null);
    inFlight.current = true;
    setAttaching(repository.id);
    const input = pendingInputs.current.get(repository.id) ?? {
      text: repositoryUseMessage(repository),
      resources: [resource],
      ...chat.extras,
      clientEventId: crypto.randomUUID(),
    };
    pendingInputs.current.set(repository.id, input);
    let accepted: Awaited<ReturnType<typeof context.client.sendMessage>>;
    try {
      accepted = await context.client.sendMessage(workspaceId, sessionId, input);
    } catch (failure) {
      inFlight.current = false;
      if (alive.current) {
        setAttaching(null);
        setAttachError(
          `Couldn't add ${repository.fullName} to this chat. ${userErrorText(failure, "Try again.")}`,
        );
      }
      return;
    }
    pendingInputs.current.delete(repository.id);
    inFlight.current = false;
    if (!alive.current) return;
    setAttaching(null);
    setOptimistic((current) => [...current, resource]);
    const routing = (accepted.payload as { routing?: unknown } | null)?.routing;
    setOutcome(
      routing === "queued_for_execution"
        ? `Queued. The agent picks up ${repository.fullName} on its next turn.`
        : routing === "accepted_for_steering"
          ? `Sent. ${repository.fullName} replaced the request this chat was waiting on.`
          : null,
    );
    // The pressed button becomes "In this chat" on the next render; keep focus
    // in the card, where the status line announces the change.
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (!focused || focused === document.body) cardRef.current?.focus();
    });
    // The message is accepted; a failed re-read only delays the session view.
    await onConfigured?.().catch(() => {});
  }

  async function openGitHub(installationId: number) {
    if (openingInstallation !== null) return;
    // Open the tab inside the click so it is not blocked, then mint a fresh
    // link: links carry ten-minute signed state. The chat stays open here.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    setOpeningInstallation(installationId);
    setLinkError(null);
    try {
      const { openGitHubInstallationSettings } = await import("@/lib/github-app-connect");
      await openGitHubInstallationSettings(context.client, workspaceId, installationId, (url) =>
        tab ? tab.location.replace(url) : window.location.assign(url),
      );
      onOpenedGitHub();
    } catch (failure) {
      tab?.close();
      if (alive.current)
        setLinkError(`Couldn't open GitHub. ${userErrorText(failure, "Try again.")}`);
    } finally {
      if (alive.current) setOpeningInstallation(null);
    }
  }

  return {
    rows,
    revoked,
    loading: repositories.length === 0 && (!context.githubCatalogReady || context.repoBusy),
    loadFailed:
      context.githubStatusFailed && !context.githubCatalogReady && repositories.length === 0,
    retry: () => void context.refreshGitHub(workspaceId),
    installations: (status?.installations ?? []).filter(
      (installation) => installation.lifecycle === "active",
    ),
    attaching,
    attachError,
    outcome,
    confirming,
    cancelConfirm: () => setConfirming(null),
    linkError,
    openingInstallation,
    statusLabel: usingRepositoriesLabel(attachedNames),
    accountLabel,
    attach: (repository: GitHubRepository, resource: RepositoryResource, confirmed = false) =>
      void attach(repository, resource, confirmed),
    openGitHub: (installationId: number) => void openGitHub(installationId),
  };
}

function GitHubRepositoryPanel({
  chooser,
  canMessage,
  canManage,
  personal,
}: {
  chooser: RepositoryChooser;
  canMessage: boolean;
  canManage: boolean;
  personal: boolean;
}) {
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(GITHUB_CARD_PAGE_SIZE);
  const listRef = useRef<HTMLDivElement>(null);
  const total = chooser.rows.length;
  const matches = chooser.rows.filter((row) => matchesRepositorySearch(row.repository, query));
  const shown = matches.slice(0, visible);
  const hidden = matches.length - shown.length;
  const available = chooser.rows.filter((row) => row.state.kind === "available");
  const groups = repositoryGroups(shown, chooser.accountLabel);
  const confirmRow =
    chooser.confirming === null
      ? null
      : (chooser.rows.find((row) => row.repository.id === chooser.confirming) ?? null);
  // With exactly one usable repository the row's action is the card's primary one.
  const single = available.length === 1 && total === 1;

  const githubLinks = canManage ? (
    <>
      {chooser.installations.map((installation) => (
        <button
          key={installation.installationId}
          type="button"
          disabled={chooser.openingInstallation !== null}
          onClick={() => chooser.openGitHub(installation.installationId)}
          className="inline-flex items-center gap-1 font-medium text-brand underline-offset-4 hover:underline disabled:opacity-60 pointer-coarse:min-h-11"
        >
          {chooser.installations.length > 1 && installation.accountLogin
            ? `Choose ${installation.accountLogin} repositories`
            : "Choose repositories on GitHub"}
          {chooser.openingInstallation === installation.installationId ? (
            <Loader2Icon aria-hidden="true" className="size-3 animate-spin" />
          ) : (
            <ArrowUpRightIcon aria-hidden="true" className="size-3" />
          )}
          <span className="sr-only"> (opens in a new tab)</span>
        </button>
      ))}
    </>
  ) : null;

  return (
    <div
      data-slot="github-repositories"
      className="border-t border-border px-[19px] pt-3 pb-4 max-[480px]:px-3.5"
    >
      {chooser.loading ? (
        chooser.loadFailed ? (
          <Notice
            tone="failed"
            className="text-xs"
            action={
              <RowButton onClick={chooser.retry} className="h-7">
                Retry
              </RowButton>
            }
          >
            Couldn't load this workspace's repositories.
          </Notice>
        ) : (
          <RowList label="GitHub repositories" busy flush>
            <ListRowSkeleton count={2} />
          </RowList>
        )
      ) : total === 0 && chooser.revoked.length === 0 ? (
        <div className="space-y-2 py-1">
          <p className="text-sm font-medium text-fg">No repositories shared yet</p>
          <p className="text-xs leading-[1.6] text-fg-muted">
            {canManage
              ? "GitHub isn't sharing any repositories with this workspace. Choose which ones it can use."
              : "GitHub isn't sharing any repositories with this workspace. Ask a workspace admin to choose some on GitHub."}
          </p>
          {canManage ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {chooser.installations.map((installation) => (
                <Button
                  key={installation.installationId}
                  type="button"
                  size="sm"
                  className="rounded-[10px] text-xs pointer-coarse:h-11"
                  disabled={chooser.openingInstallation !== null}
                  onClick={() => chooser.openGitHub(installation.installationId)}
                >
                  {chooser.installations.length > 1 && installation.accountLogin
                    ? `Choose ${installation.accountLogin} repositories`
                    : "Choose repositories on GitHub"}
                  {chooser.openingInstallation === installation.installationId ? (
                    <Loader2Icon aria-hidden="true" className="animate-spin" />
                  ) : (
                    <ArrowUpRightIcon aria-hidden="true" />
                  )}
                  <span className="sr-only"> (opens in a new tab)</span>
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <h4 className="m-0 text-xs font-medium text-fg-muted">
              {canMessage ? "Use a repository in this chat" : "Repositories"}
            </h4>
            <span className="text-2xs text-fg-subtle tabular-nums">
              {total} {total === 1 ? "repository" : "repositories"}
            </span>
          </div>
          {total >= GITHUB_CARD_SEARCH_THRESHOLD ? (
            <Input
              type="search"
              aria-label="Search repositories"
              placeholder="Search repositories…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisible(GITHUB_CARD_PAGE_SIZE);
              }}
              className="my-2 h-8 text-xs"
            />
          ) : null}
          {chooser.attachError ? (
            <Notice tone="failed" live="assertive" className="my-2 text-xs">
              {chooser.attachError}
            </Notice>
          ) : null}
          {chooser.revoked.length > 0 ? (
            <RowList label="Repositories GitHub no longer shares" flush>
              {chooser.revoked.map((resource) => (
                <ListRow
                  key={`revoked:${resource.githubInstallationId}:${resource.githubRepositoryId}`}
                  leading={<LogoTile icon={<BookMarkedIcon />} />}
                  title={repositoryDisplayName(resource)}
                  disabled
                  disabledReason={
                    canManage
                      ? "GitHub no longer shares this repository with the workspace. Choose repositories on GitHub to restore it."
                      : "GitHub no longer shares this repository with the workspace. Ask a workspace admin to restore it."
                  }
                  indicator={{ kind: "unavailable", label: "Access removed" }}
                />
              ))}
            </RowList>
          ) : null}
          {confirmRow ? (
            <Notice
              tone="waiting"
              live="polite"
              className="my-2 text-xs"
              actionLayout="responsive"
              action={
                <span className="flex gap-1.5">
                  <RowButton className="h-7" onClick={chooser.cancelConfirm}>
                    Cancel
                  </RowButton>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 rounded-[10px] text-xs"
                    onClick={() =>
                      confirmRow.state.kind === "available" &&
                      chooser.attach(confirmRow.repository, confirmRow.state.resource, true)
                    }
                  >
                    Use anyway
                  </Button>
                </span>
              }
            >
              This chat is waiting for your answer. Using {confirmRow.repository.fullName} now
              replaces that request, like sending a message.
            </Notice>
          ) : null}
          <div ref={listRef} tabIndex={-1} className="outline-none">
            {groups.map((group) => (
              <section key={group.installationId} aria-label={group.label ?? undefined}>
                {group.label ? (
                  <h5 className="m-0 mt-2 text-2xs font-medium tracking-wide text-fg-subtle uppercase">
                    {group.label}
                  </h5>
                ) : null}
                {group.note ? (
                  <p className="m-0 mt-0.5 text-xs leading-[1.6] text-fg-muted">{group.note}</p>
                ) : null}
                <RowList
                  label={group.label ? `${group.label} repositories` : "GitHub repositories"}
                  flush
                >
                  {group.rows.map(({ repository, state }) => (
                    <RepositoryListRow
                      key={`${repository.installationId}:${repository.id}`}
                      repository={repository}
                      state={state}
                      explained={Boolean(group.note)}
                      canMessage={canMessage}
                      primary={single}
                      busy={chooser.attaching === repository.id}
                      locked={chooser.attaching !== null}
                      onUse={(resource) => chooser.attach(repository, resource)}
                    />
                  ))}
                </RowList>
              </section>
            ))}
          </div>
          {query.trim() && matches.length === 0 ? (
            <p className="py-3 text-center text-xs text-fg-muted">
              No repositories match “{query.trim()}”.
            </p>
          ) : null}
          {hidden > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-1 w-full text-xs text-fg-muted pointer-coarse:h-11"
              onClick={() => {
                // The button leaves with the last page; keep focus in the list.
                if (hidden <= GITHUB_CARD_MORE_SIZE) listRef.current?.focus();
                setVisible((current) => current + GITHUB_CARD_MORE_SIZE);
              }}
            >
              Show {Math.min(hidden, GITHUB_CARD_MORE_SIZE)} more
            </Button>
          ) : null}
          <p
            role="status"
            className={cn(
              "m-0 text-xs leading-[1.6] text-fg-muted",
              chooser.outcome ? "mt-2" : "sr-only",
            )}
          >
            {chooser.outcome}
          </p>
          <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-xs leading-[1.6] text-fg-muted">
            <p className="m-0">
              {!canMessage
                ? "Only people who can message this chat can add a repository to it."
                : personal
                  ? "Using a repository adds it to this chat only."
                  : "Shared with everyone in this workspace. Using one adds it to this chat only."}
            </p>
            {githubLinks ? (
              <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>Missing one?</span>
                {githubLinks}
              </p>
            ) : (
              <p className="m-0">Missing one? Ask a workspace admin to share it on GitHub.</p>
            )}
          </div>
        </>
      )}
      {chooser.linkError ? (
        <p role="alert" className="mt-2 text-xs text-status-failed">
          {chooser.linkError}
        </p>
      ) : null}
    </div>
  );
}

// Locked while another attach is in flight: focusable (so focus is not lost)
// but visibly and functionally inactive.
const LOCKED = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

function RepositoryListRow({
  repository,
  state,
  explained,
  canMessage,
  primary,
  busy,
  locked,
  onUse,
}: {
  repository: GitHubRepository;
  state: GitHubRepositoryChatState;
  /** The group already says why these rows can't be used here. */
  explained: boolean;
  canMessage: boolean;
  primary: boolean;
  busy: boolean;
  locked: boolean;
  onUse: (resource: RepositoryResource) => void;
}) {
  const meta = [repository.defaultBranch, repository.private ? null : "Public"].filter(Boolean);
  const titleAddon = repository.private ? (
    <LockIcon role="img" aria-label="Private" className="size-3 shrink-0 text-fg-subtle" />
  ) : null;
  const common = {
    leading: <LogoTile icon={<BookMarkedIcon />} />,
    title: repository.fullName,
    titleAddon,
    meta,
  };
  if (state.kind === "blocked") {
    return (
      <ListRow
        {...common}
        disabled
        disabledReason={explained && state.cause === "other_account" ? undefined : state.reason}
      />
    );
  }
  if (state.kind === "attached") {
    return (
      <ListRow
        {...common}
        control={
          <span className="inline-flex items-center gap-1 text-xs font-medium text-status-idle">
            <CheckIcon aria-hidden="true" className="size-3.5" />
            In this chat
          </span>
        }
      />
    );
  }
  if (!canMessage) return <ListRow {...common} />;
  return (
    <ListRow
      {...common}
      control={
        primary ? (
          <Button
            type="button"
            size="sm"
            aria-disabled={locked || undefined}
            aria-label={
              busy ? `Adding ${repository.fullName}` : `Use ${repository.fullName} in this chat`
            }
            className={cn("rounded-[10px] pointer-coarse:h-11", LOCKED)}
            onClick={() => {
              if (!locked) onUse(state.resource);
            }}
          >
            {busy ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : null}
            {busy ? "Adding…" : "Use in this chat"}
          </Button>
        ) : (
          <RowButton
            aria-disabled={locked || undefined}
            aria-label={
              busy ? `Adding ${repository.fullName}` : `Use ${repository.fullName} in this chat`
            }
            className={cn(LOCKED, busy && "text-fg-muted")}
            onClick={() => {
              if (!locked) onUse(state.resource);
            }}
          >
            {busy ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : null}
            {busy ? "Adding…" : "Use"}
          </RowButton>
        )
      }
    />
  );
}

type RepositoryGroup = {
  installationId: number;
  label: string | null;
  note: string | null;
  rows: RepositoryRow[];
};

/**
 * One section per GitHub account once repositories come from more than one.
 * A chat holds one App token, so an account whose every row is blocked says so
 * once instead of on each row.
 */
function repositoryGroups(
  rows: readonly RepositoryRow[],
  accountLabel: (installationId: number) => string,
): RepositoryGroup[] {
  const byInstallation = new Map<number, RepositoryRow[]>();
  for (const row of rows) {
    const group = byInstallation.get(row.repository.installationId) ?? [];
    group.push(row);
    byInstallation.set(row.repository.installationId, group);
  }
  if (byInstallation.size <= 1) {
    return [
      {
        installationId: rows[0]?.repository.installationId ?? 0,
        label: null,
        note: null,
        rows: [...rows],
      },
    ];
  }
  return [...byInstallation.entries()].map(([installationId, groupRows]) => {
    const label = accountLabel(installationId);
    const first = groupRows[0]?.state;
    const blocked = groupRows.every(
      (row) => row.state.kind === "blocked" && row.state.cause === "other_account",
    );
    const using = first?.kind === "blocked" ? first.usingAccount : undefined;
    return {
      installationId,
      label,
      note: blocked
        ? `This chat already uses ${using ?? "another account"}'s repositories. Start a new chat to use ${label}'s.`
        : null,
      rows: groupRows,
    };
  });
}
