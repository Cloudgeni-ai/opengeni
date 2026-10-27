import { t } from "../lib/console-text";
import { ArtifactSessionPage } from "../components/session/artifact-session-page";
import type {
  WorkspaceArtifactContentResponse,
  WorkspaceArtifactDetailResponse,
} from "@opengeni/sdk";
import { SiteView, artifactLoadErrorMessage, artifactLoadErrorView } from "../../artifacts";
import { loadSiteSnapshot } from "../../sites";
import { SiteConversations } from "../components/artifacts/site-conversations";
import { SiteData } from "../components/artifacts/site-data";
import { SitePublishButton, sitePublicationHeader } from "../components/artifacts/site-publishing";
import {
  SiteSettings,
  hasSiteSettings,
  useSiteManagement,
} from "../components/artifacts/site-settings";
import { Link, useNavigate, useSearch } from "../lib/navigation";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  PanelsTopLeftIcon,
  PlusIcon,
  RotateCcwIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../lib/toast";

import { ArtifactLibrary } from "../components/artifacts/artifact-library";
import {
  ARTIFACT_DETAIL_FRAME,
  ArtifactKindTile,
  useArtifactsBackLink,
} from "../components/artifacts/artifact-page-chrome";
import { artifactKinds, type ArtifactKind } from "../lib/artifact-catalog";
import { invalidateArtifactCatalog, useArtifactCatalog } from "../lib/use-artifact-catalog";
import { useArtifactCatalogMutationInvalidation } from "../lib/use-artifact-catalog-mutation-invalidation";
import { Button } from "../../ui/button";
import { ContentPage } from "../../ui/content-layout";
import { DetailPage, DetailPageBody, DetailPageHeader } from "../../ui/detail-page";
import { DetailSection } from "../../ui/detail-sheet";
import { LineTabs, LineTabsContent, LineTabsList, LineTabsTrigger } from "../../ui/line-tabs";
import { ListRow, RowList } from "../../ui/list-row";
import { MetaChip } from "../../ui/meta-chip";
import { Notice } from "../../ui/notice";
import { RowButton } from "../../ui/page-actions";
import { PageHeader } from "../../ui/page-header";
import { RelativeTime } from "../../ui/relative-time";
import { Skeleton } from "../../ui/skeleton";
import { StatusBadge } from "../../ui/status-badge";
import { useAppContext } from "../app-context";
import { ARTIFACT_ACCESS_REQUIRED, isArtifactReadDenied } from "../lib/artifact-access";
import { useConsoleSiteToolBridge, useConsoleSiteViewer } from "../lib/console-site";
import { readyNewChat } from "../lib/ready-new-chat";
import { userErrorText } from "../../ui/api-error";
import { newArtifactPrompt } from "../lib/site-edit-prompt";
import { hasWorkspacePermission, lacksWorkspacePermission } from "../lib/permissions";
import {
  artifactLibraryFilters,
  artifactLibraryPositionKey,
  artifactLibrarySearch,
  readArtifactLibraryPosition,
  useArtifactLibraryPosition,
} from "../lib/artifact-library-navigation";
import type { ArtifactCatalogFilters } from "../lib/artifact-catalog";
import type { ArtifactReturnSearch, SiteDetailTab } from "../lib/routes";
import { errorMessage } from "@opengeni/contracts/values";

// The Site view opens the same publish form through this route's code,
// loaded when needed, so the form stays with the Site's Settings tab.
export { SitePublishingPage } from "../components/artifacts/site-publishing-page";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SiteLoadError({
  error,
  accessDenied,
  onRetry,
}: {
  error: unknown;
  accessDenied: boolean;
  onRetry: () => void;
}) {
  if (accessDenied)
    return <Notice title="You can't open this Site">{ARTIFACT_ACCESS_REQUIRED}</Notice>;
  const view = artifactLoadErrorView(t, error, "site");
  return (
    <Notice
      tone="failed"
      live="assertive"
      title={view.title}
      actionLayout="responsive"
      action={
        view.retryable ? (
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            <RotateCcwIcon aria-hidden="true" />
            Retry
          </Button>
        ) : undefined
      }
    >
      {artifactLoadErrorMessage(t, view)}
    </Notice>
  );
}

export function ArtifactsRoute({
  workspaceId,
  artifactId,
  fromSession,
}: {
  workspaceId: string;
  artifactId?: string | undefined;
  fromSession?: string | undefined;
}) {
  const search = useSearch({ strict: false }) as ArtifactReturnSearch;
  // Straight to the Site view, without this page's chrome first.
  if (artifactId && opensSiteView(search))
    return <OpenSiteView workspaceId={workspaceId} artifactId={artifactId} />;
  return artifactId ? (
    <ArtifactSessionPage
      workspaceId={workspaceId}
      artifactId={artifactId}
      fromSession={fromSession}
    >
      <ArtifactDetailRoute
        key={`${workspaceId}:${artifactId}`}
        workspaceId={workspaceId}
        artifactId={artifactId}
        fromSession={fromSession}
      />
    </ArtifactSessionPage>
  ) : (
    <ArtifactSessionPage workspaceId={workspaceId} fromSession={fromSession}>
      <ArtifactListRoute key={workspaceId} workspaceId={workspaceId} fromSession={fromSession} />
    </ArtifactSessionPage>
  );
}

function ArtifactListRoute({
  workspaceId,
  fromSession,
}: {
  workspaceId: string;
  fromSession?: string | undefined;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const filters = artifactLibraryFilters(search);
  const setFilters = (next: ArtifactCatalogFilters) => {
    void navigate({
      to: "/workspaces/$workspaceId/artifacts",
      params: { workspaceId },
      search: artifactLibrarySearch(next, fromSession),
      replace: true,
      resetScroll: false,
    });
  };
  const positionKey = artifactLibraryPositionKey(workspaceId, context.accessKeyVersion, filters);
  // Freeze the restore count for this query; loading another page must not
  // recreate the catalog's request lifecycle.
  const retained = useRef({
    key: positionKey,
    client: context.client,
    pages: readArtifactLibraryPosition(context.client, positionKey).pages,
  });
  if (retained.current.key !== positionKey || retained.current.client !== context.client)
    retained.current = {
      key: positionKey,
      client: context.client,
      pages: readArtifactLibraryPosition(context.client, positionKey).pages,
    };
  const [empty, setEmpty] = useState(false);
  const catalog = useArtifactCatalog(
    context.client,
    workspaceId,
    filters,
    context.accessKeyVersion,
    retained.current.pages,
  );
  const position = useArtifactLibraryPosition(
    context.client,
    positionKey,
    // The viewer may have repopulated an invalidated cache with only its first
    // page. Do not consume scroll restoration before the retained pages reload.
    catalog.loading ||
      Boolean(catalog.error) ||
      Boolean(catalog.nextCursor && catalog.pages < retained.current.pages),
    catalog.items.length,
    catalog.pages,
  );
  const invalidateAfterMutation = useArtifactCatalogMutationInvalidation(
    context.client,
    workspaceId,
    invalidateArtifactCatalog,
  );
  const canCreate = hasWorkspacePermission(context.accessContext, workspaceId, "sessions:create");
  const canPin = hasWorkspacePermission(context.accessContext, workspaceId, "artifacts:publish");
  // The catalog quietly omits Sites and editable artifacts without `artifacts:read`.
  const artifactKindsHidden = lacksWorkspacePermission(
    context.accessContext,
    workspaceId,
    "artifacts:read",
  );
  // Readies a new chat in the composer; the person says what to make and sends it.
  const [preparingNew, setPreparingNew] = useState(false);
  const startSession = async () => {
    if (preparingNew) return;
    setPreparingNew(true);
    try {
      await readyNewChat(context.client, workspaceId, newArtifactPrompt(filters.kind));
      await navigate({ to: "/workspaces/$workspaceId/sessions", params: { workspaceId } });
    } catch (nextError) {
      toast.error("Couldn't open a new chat", { description: userErrorText(nextError) });
    } finally {
      setPreparingNew(false);
    }
  };
  const newArtifact = canCreate ? (
    <Button
      type="button"
      onClick={() => void startSession()}
      disabled={context.busy || preparingNew}
      className="pointer-coarse:h-11"
    >
      <PlusIcon aria-hidden="true" />
      New artifact
    </Button>
  ) : null;
  return (
    <ContentPage width="standard" className="pt-6" {...position}>
      <LineTabs
        value={filters.kind}
        onValueChange={(kind) => setFilters({ ...filters, kind: kind as ArtifactKind | "all" })}
        className="min-w-0"
      >
        <PageHeader
          icon={<PanelsTopLeftIcon />}
          title="Artifacts"
          description="Sites, images, documents and files made with Opengeni"
          actions={empty && filters.kind === "all" ? null : newArtifact}
          tabs={
            <LineTabsList aria-label="Artifact types">
              {artifactKinds.map(([kind, label]) => (
                <LineTabsTrigger key={kind} value={kind}>
                  {label}
                </LineTabsTrigger>
              ))}
            </LineTabsList>
          }
        />
        <LineTabsContent value={filters.kind} className="pt-6">
          <ArtifactLibrary
            workspaceId={workspaceId}
            sessionId={fromSession}
            browseSearch={artifactLibrarySearch(filters, fromSession, true)}
            items={catalog.items}
            filters={filters}
            onFiltersChange={setFilters}
            loading={catalog.loading}
            error={catalog.error}
            onRetry={catalog.retry}
            nextCursor={catalog.nextCursor}
            onLoadMore={catalog.loadMore}
            emptyAction={newArtifact}
            onEmptyChange={setEmpty}
            artifactKindsHidden={artifactKindsHidden}
            onPin={
              canPin
                ? async (item, pinned) => {
                    await context.client.updateArtifactPin(workspaceId, item.kind, item.id, pinned);
                    invalidateAfterMutation();
                    await catalog.refresh();
                  }
                : undefined
            }
          />
        </LineTabsContent>
      </LineTabs>
    </ContentPage>
  );
}

type SiteTab = "site" | SiteDetailTab;

export function ArtifactDetailRoute({
  embedded = false,
  embeddedView = "site",
  ...props
}: {
  workspaceId: string;
  artifactId: string;
  fromSession?: string | undefined;
  embedded?: boolean | undefined;
  /** In the session workbench: the Site itself, or its Settings. */
  embeddedView?: "site" | "settings" | undefined;
  /** The workbench header's reload and full screen, which replace the frame toolbar. */
  embeddedControls?: EmbeddedSiteControls | undefined;
}) {
  const { embeddedControls, ...route } = props;
  if (!embedded) return <ArtifactDetailOrSite {...route} />;
  return embeddedView === "settings" ? (
    <EmbeddedSiteSettings {...route} />
  ) : (
    <EmbeddedSiteDetail {...route} controls={embeddedControls} />
  );
}

export type EmbeddedSiteControls = {
  reloadToken: number;
  fullScreen: boolean;
  onFullScreenChange: (fullScreen: boolean) => void;
};

/**
 * The session dock's Site Settings: the Site page's Settings tab, so the Site
 * can be published, shared or archived without leaving the session.
 */
function EmbeddedSiteSettings({
  workspaceId,
  artifactId,
}: {
  workspaceId: string;
  artifactId: string;
}) {
  const context = useAppContext();
  const [artifact, setArtifact] = useState<WorkspaceArtifactDetailResponse["artifact"] | null>(
    null,
  );
  const [error, setError] = useState<unknown>(null);
  const readAbort = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    readAbort.current?.abort();
    const abort = new AbortController();
    readAbort.current = abort;
    try {
      setError(null);
      const detail = await context.client.getWorkspaceArtifact(workspaceId, artifactId, {
        signal: abort.signal,
      });
      if (!abort.signal.aborted) setArtifact(detail.artifact);
    } catch (nextError) {
      if (abort.signal.aborted) return;
      setArtifact(null);
      setError(nextError);
    }
  }, [artifactId, workspaceId, context.client]);
  useEffect(() => {
    setArtifact(null);
    void load();
    return () => readAbort.current?.abort();
  }, [load]);
  const management = useSiteManagement({
    workspaceId,
    siteId: artifactId,
    artifact,
    onArtifactChanged: setArtifact,
    onStatusChanged: load,
  });
  return (
    <div className="h-full min-h-0 overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-[720px] px-4 py-5">
        {error ? (
          <SiteLoadError
            error={error}
            accessDenied={isArtifactReadDenied(error, context.accessContext, workspaceId)}
            onRetry={() => void load()}
          />
        ) : !artifact ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-48 w-full rounded-lg" />
            <span className="sr-only" role="status">
              Loading Site settings
            </span>
          </div>
        ) : (
          <SiteSettings
            workspaceId={workspaceId}
            artifact={artifact}
            management={management}
            openCopy={false}
          />
        )}
      </div>
      {management.showAudience ? management.audience.dialog : null}
    </div>
  );
}

/** The session dock's Site view: the shared SiteView with console tool access. */
function EmbeddedSiteDetail({
  workspaceId,
  artifactId,
  controls,
}: {
  workspaceId: string;
  artifactId: string;
  controls?: EmbeddedSiteControls | undefined;
}) {
  const { client } = useAppContext();
  const viewer = useConsoleSiteViewer();
  const toolBridge = useConsoleSiteToolBridge(workspaceId);
  return (
    <SiteView
      client={client}
      workspaceId={workspaceId}
      siteId={artifactId}
      toolBridge={toolBridge}
      viewer={viewer}
      showTitle={false}
      {...(controls
        ? {
            showToolbar: false,
            reloadToken: controls.reloadToken,
            fullScreen: controls.fullScreen,
            onFullScreenChange: controls.onFullScreenChange,
          }
        : {})}
      archivedMessage="This Site is archived. Restore it from its settings."
    />
  );
}

/**
 * A Site opens in the Site view, with its chat beside it: a link, a copied
 * address or a notification naming `/artifacts/:id` lands there. Its details
 * (Versions, Conversations, Data, Settings) stay here, by tab.
 */
function ArtifactDetailOrSite(props: {
  workspaceId: string;
  artifactId: string;
  fromSession?: string | undefined;
}) {
  const search = useSearch({ strict: false }) as ArtifactReturnSearch;
  return opensSiteView(search) ? <OpenSiteView {...props} /> : <ArtifactDetailPage {...props} />;
}

/** `/artifacts/:id` without a tab (or the publish view) is the Site itself. */
function opensSiteView(search: ArtifactReturnSearch): boolean {
  return search.view !== "publish" && search.tab === undefined;
}

function OpenSiteView({ workspaceId, artifactId }: { workspaceId: string; artifactId: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({
      to: "/workspaces/$workspaceId/sites/$siteId",
      params: { workspaceId, siteId: artifactId },
      replace: true,
    });
  }, [artifactId, navigate, workspaceId]);
  return (
    <span className="sr-only" role="status">
      Opening Site
    </span>
  );
}

function ArtifactDetailPage({
  workspaceId,
  artifactId,
  fromSession,
}: {
  workspaceId: string;
  artifactId: string;
  fromSession?: string | undefined;
}) {
  const context = useAppContext();
  const canPublish = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "artifacts:publish",
  );
  const navigate = useNavigate();
  const back = useArtifactsBackLink(workspaceId, fromSession);
  const search = useSearch({ strict: false }) as ArtifactReturnSearch;
  // The tab is in the address, so Settings (from the workbench or the old
  // Publish link) and the other tabs can be linked to and survive a reload.
  // The Site itself is the Site view, with its chat beside it.
  const tab: SiteDetailTab = search.view === "publish" ? "settings" : (search.tab ?? "versions");
  const openSiteView = (startNew = false) =>
    void navigate({
      to: "/workspaces/$workspaceId/sites/$siteId",
      params: { workspaceId, siteId: artifactId },
      ...(startNew ? { search: { new: true } } : {}),
    });
  const setTab = (next: SiteTab) =>
    next === "site"
      ? openSiteView()
      : void navigate({
          to: "/workspaces/$workspaceId/artifacts/$artifactId",
          params: { workspaceId, artifactId },
          search: { ...search, view: undefined, tab: next },
          replace: true,
          resetScroll: false,
        });
  const [detail, setDetail] = useState<WorkspaceArtifactDetailResponse | null>(null);
  const [content, setContent] = useState<Pick<
    WorkspaceArtifactContentResponse,
    "html" | "versionId" | "requestedTools"
  > | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyVersion, setBusyVersion] = useState<string | null>(null);
  const readAbort = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    readAbort.current?.abort();
    const abort = new AbortController();
    readAbort.current = abort;
    try {
      setError(null);
      const snapshot = await loadSiteSnapshot(context.client, workspaceId, artifactId, {
        signal: abort.signal,
        includeArchivedContent: true,
      });
      if (abort.signal.aborted) return;
      setDetail(snapshot.detail);
      setContent(snapshot.content);
    } catch (nextError) {
      if (abort.signal.aborted) return;
      setDetail(null);
      setContent(null);
      setError(nextError);
    }
  }, [artifactId, workspaceId, context.client]);
  useEffect(() => {
    setDetail(null);
    setContent(null);
    void load();
    return () => readAbort.current?.abort();
  }, [load]);
  // Edit with Opengeni opens the Site view with a new conversation beside
  // the Site, its composer focused: the person says what to change and it
  // goes live there.
  const startEditSession = () => {
    if (!canPublish || !detail || detail.artifact.status === "archived") return;
    openSiteView(true);
  };
  const rollback = async (versionId: string) => {
    const current = detail?.artifact.currentVersion;
    if (
      !canPublish ||
      !current ||
      current.id === versionId ||
      detail?.artifact.status === "archived"
    )
      return;
    setBusyVersion(versionId);
    try {
      await context.client.rollbackWorkspaceArtifact(workspaceId, artifactId, {
        versionId,
        expectedCurrentVersionId: current.id,
        reason: `Restored from the artifact history by ${context.authSession?.user?.name ?? "a workspace member"}`,
        idempotencyKey: crypto.randomUUID(),
      });
      invalidateArtifactCatalog(context.client, workspaceId);
      toast.success("Artifact version restored");
      await load();
    } catch (nextError) {
      toast.error("Couldn't restore version", {
        description: errorMessage(nextError),
      });
    } finally {
      setBusyVersion(null);
    }
  };
  const archived = detail?.artifact.status === "archived";
  const management = useSiteManagement({
    workspaceId,
    siteId: artifactId,
    artifact: detail?.artifact ?? null,
    onArtifactChanged: (artifact) =>
      setDetail((current) => (current ? { ...current, artifact } : current)),
    onStatusChanged: load,
  });
  const { manageData, publication, audience, showAudience, statusBusy, setSiteStatus } = management;
  if (error) {
    return (
      <ContentPage width="standard" className={ARTIFACT_DETAIL_FRAME}>
        <DetailPage back={back}>
          <SiteLoadError
            error={error}
            accessDenied={isArtifactReadDenied(error, context.accessContext, workspaceId)}
            onRetry={() => void load()}
          />
        </DetailPage>
      </ContentPage>
    );
  }
  // Content is null once loaded when the Site has no version this person can
  // open; that is a final state, not a reason to keep showing the skeleton.
  if (!detail) {
    return (
      <ContentPage width="standard" className={ARTIFACT_DETAIL_FRAME}>
        <DetailPage back={back}>
          <div className="flex items-start gap-4" aria-busy="true">
            <Skeleton className="size-10 rounded-[10px]" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-6 w-64 max-w-full" />
              <Skeleton className="h-4 w-80 max-w-full" />
            </div>
          </div>
          <Skeleton className="mt-8 h-96 w-full rounded-[14px]" />
          <span className="sr-only" role="status">
            Loading Site
          </span>
        </DetailPage>
      </ContentPage>
    );
  }

  const artifact = detail.artifact;
  const toolCount = content?.requestedTools.length ?? 0;
  const publicationHeader = sitePublicationHeader(publication.load);
  const showSettings = hasSiteSettings(management);
  const shownTab: SiteTab =
    (tab === "settings" && !showSettings) || (tab === "data" && !manageData) ? "versions" : tab;
  return (
    <ContentPage width="standard" className={ARTIFACT_DETAIL_FRAME}>
      <DetailPage back={back}>
        <LineTabs
          value={shownTab}
          onValueChange={(value) => setTab(value as SiteTab)}
          // Site leaves the page for the Site view: arrowing past it must
          // not, so a tab opens on Enter, Space or a click.
          activationMode="manual"
        >
          <DetailPageHeader
            leading={<ArtifactKindTile kind="site" />}
            title={artifact.title}
            chips={
              showAudience || archived || publicationHeader.chip ? (
                <>
                  {showAudience ? audience.chip : null}
                  {publicationHeader.chip}
                  {archived ? (
                    <StatusBadge tone="neutral" icon="auto">
                      Archived
                    </StatusBadge>
                  ) : null}
                </>
              ) : null
            }
            meta={[
              artifact.currentVersion ? `Version ${artifact.currentVersion.revision}` : null,
              publicationHeader.meta,
              toolCount > 0 ? `Uses ${toolCount} ${toolCount === 1 ? "tool" : "tools"}` : null,
              <RelativeTime key="updated" date={artifact.updatedAt} prefix="Updated" inSentence />,
            ]}
            actions={
              canPublish ? (
                <>
                  {showAudience ? audience.shareButton : null}
                  {manageData && !archived ? (
                    <SitePublishButton load={publication.load} onOpen={() => setTab("settings")} />
                  ) : null}
                  {archived ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void setSiteStatus("active")}
                      disabled={statusBusy}
                      className="rounded-[10px] pointer-coarse:h-11"
                    >
                      <ArchiveRestoreIcon aria-hidden="true" />
                      {statusBusy ? "Restoring…" : "Restore Site"}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      onClick={startEditSession}
                      disabled={context.busy}
                      className="rounded-[10px] pointer-coarse:h-11"
                    >
                      <SparklesIcon aria-hidden="true" />
                      Edit with Opengeni
                    </Button>
                  )}
                </>
              ) : null
            }
            tabs={
              <LineTabsList aria-label="Site">
                <LineTabsTrigger value="site">Site</LineTabsTrigger>
                <LineTabsTrigger value="versions" count={detail.versions.length}>
                  Versions
                </LineTabsTrigger>
                <LineTabsTrigger value="conversations">Conversations</LineTabsTrigger>
                {manageData ? <LineTabsTrigger value="data">Data</LineTabsTrigger> : null}
                {showSettings ? <LineTabsTrigger value="settings">Settings</LineTabsTrigger> : null}
              </LineTabsList>
            }
          />
          {artifact.description || archived ? (
            <div className="flex min-w-0 flex-col gap-4 pt-6">
              {artifact.description ? (
                <p className="text-sm leading-5 text-fg-muted">{artifact.description}</p>
              ) : null}
              {archived ? (
                <Notice icon={<ArchiveIcon className="size-4" />} title="This Site is archived">
                  It's unpublished. Its source and versions are kept: restore it to edit it or bring
                  back an earlier version.
                </Notice>
              ) : null}
            </div>
          ) : null}
          <LineTabsContent value="versions">
            <DetailPageBody>
              <DetailSection
                title="Version history"
                description="Restore an earlier version without losing the current one."
              >
                <RowList label="Versions" flush>
                  {detail.versions.map((version) => {
                    const current = artifact.currentVersion?.id === version.id;
                    return (
                      <ListRow
                        key={version.id}
                        title={`Version ${version.revision}`}
                        titleAddon={current ? <MetaChip variant="soft">Current</MetaChip> : null}
                        meta={[
                          <RelativeTime key="created" date={version.createdAt} />,
                          formatSize(version.sizeBytes),
                          version.sourceSessionId ? (
                            <Link
                              key="session"
                              to="/workspaces/$workspaceId/sessions/$sessionId"
                              params={{
                                workspaceId,
                                sessionId: version.sourceSessionId,
                              }}
                              className="relative z-10 font-medium og-link text-fg-muted hover:text-fg"
                            >
                              {version.revision === 1 ? "Creation session" : "Publishing session"}
                            </Link>
                          ) : null,
                        ].filter(Boolean)}
                        control={
                          !current && canPublish ? (
                            <RowButton
                              disabled={busyVersion !== null || archived}
                              onClick={() => void rollback(version.id)}
                            >
                              <RotateCcwIcon aria-hidden="true" />
                              {busyVersion === version.id ? "Restoring…" : "Restore"}
                            </RowButton>
                          ) : undefined
                        }
                      />
                    );
                  })}
                </RowList>
              </DetailSection>
            </DetailPageBody>
          </LineTabsContent>
          <LineTabsContent value="conversations" className="pt-6">
            <SiteConversations
              key={artifactId}
              workspaceId={workspaceId}
              siteId={artifactId}
              title={artifact.title}
              canManageAccess={
                !archived &&
                artifact.visibility === "private" &&
                artifact.ownerSubjectId === context.accessContext.subjectId
              }
            />
          </LineTabsContent>
          {manageData ? (
            <LineTabsContent value="data" className="pt-6">
              <SiteData
                key={artifactId}
                workspaceId={workspaceId}
                siteId={artifactId}
                title={artifact.title}
              />
            </LineTabsContent>
          ) : null}
          {showSettings ? (
            <LineTabsContent value="settings" className="pt-6">
              <SiteSettings workspaceId={workspaceId} artifact={artifact} management={management} />
            </LineTabsContent>
          ) : null}
        </LineTabs>
      </DetailPage>
      {showAudience ? audience.dialog : null}
    </ContentPage>
  );
}
