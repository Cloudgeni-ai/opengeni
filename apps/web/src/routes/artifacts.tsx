import { ArtifactSessionPage } from "@/components/session/artifact-session-page";
import type {
  SiteViewer,
  ToolGatewayIdentity,
  WorkspaceArtifactContentResponse,
  WorkspaceArtifactDetailResponse,
} from "@opengeni/sdk";
import {
  ArtifactSandbox,
  SiteView,
  artifactLoadErrorMessage,
  artifactLoadErrorView,
  type PublishedHtmlArtifactToolBridge,
  type SiteToolBridgeFactory,
} from "@opengeni/react/artifacts";
import { loadSiteSnapshot } from "@opengeni/react/sites";
import { SiteConversations } from "@/components/artifacts/site-conversations";
import { SiteData } from "@/components/artifacts/site-data";
import {
  SitePublishButton,
  SitePublishPage,
  sitePublicationHeader,
  useSitePublication,
} from "@/components/artifacts/site-publishing";
import { useSiteAudience } from "@/components/artifacts/site-audience";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  PanelsTopLeftIcon,
  PlusIcon,
  RotateCcwIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ArtifactLibrary } from "@/components/artifacts/artifact-library";
import {
  ARTIFACT_DETAIL_FRAME,
  ArtifactKindTile,
  useArtifactsBackLink,
} from "@/components/artifacts/artifact-page-chrome";
import { artifactKinds, type ArtifactKind } from "@/lib/artifact-catalog";
import { invalidateArtifactCatalog, useArtifactCatalog } from "@/lib/use-artifact-catalog";
import { useArtifactCatalogMutationInvalidation } from "@/lib/use-artifact-catalog-mutation-invalidation";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContentPage } from "@/components/ui/content-layout";
import { DetailPage, DetailPageBody, DetailPageHeader } from "@/components/ui/detail-page";
import { DetailSection } from "@/components/ui/detail-sheet";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  LineTabs,
  LineTabsContent,
  LineTabsList,
  LineTabsTrigger,
} from "@/components/ui/line-tabs";
import { ListRow, RowList } from "@/components/ui/list-row";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAppContext } from "@/context";
import { ARTIFACT_ACCESS_REQUIRED, isArtifactReadDenied } from "@/lib/artifact-access";
import { createSiteToolBridge } from "@/lib/site-tool-bridge";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import { hasWorkspacePermission, lacksWorkspacePermission } from "@/lib/permissions";
import {
  artifactLibraryFilters,
  artifactLibraryPositionKey,
  artifactLibrarySearch,
  readArtifactLibraryPosition,
  useArtifactLibraryPosition,
} from "@/lib/artifact-library-navigation";
import type { ArtifactCatalogFilters } from "@/lib/artifact-catalog";
import type { ArtifactReturnSearch } from "@/lib/routes";
import { sitesClientConfig } from "@/lib/site-publishing";

const NO_SITE_TOOLS: readonly ToolGatewayIdentity[] = [];

/** The signed-in member as Site code sees them (`site.viewer`) in the console. */
function useConsoleSiteViewer(): SiteViewer {
  const { accessContext, authSession } = useAppContext();
  const subjectId = accessContext.subjectId;
  const name = authSession?.user?.name ?? null;
  const email = authSession?.user?.email ?? null;
  return useMemo(
    () => ({ kind: "member", id: `user:${subjectId}`, name, email, signedIn: true }),
    [email, name, subjectId],
  );
}
// Stands in for the Site while it loads so the audience hook keeps its order.
const PLACEHOLDER_SITE: WorkspaceArtifactDetailResponse["artifact"] = {
  id: "00000000-0000-4000-8000-000000000000",
  accountId: "00000000-0000-4000-8000-000000000000",
  workspaceId: "00000000-0000-4000-8000-000000000000",
  slug: "loading",
  title: "Site",
  description: null,
  status: "active",
  currentVersion: null,
  createdBySubjectId: "loading",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

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
  const view = artifactLoadErrorView(error, "site");
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
      {artifactLoadErrorMessage(view)}
    </Notice>
  );
}

export function ArtifactsRoute({
  workspaceId,
  artifactId,
  fromSession,
}: {
  workspaceId: string;
  artifactId?: string;
  fromSession?: string | undefined;
}) {
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
  fromSession?: string;
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
  const startSession = async () => {
    const created = await context.startSession(workspaceId, {
      text:
        filters.kind === "all" || filters.kind === "file"
          ? "Help me create a workspace artifact. Ask what I want to make before creating it."
          : `Help me create a workspace ${filters.kind}. Ask what it should contain before creating it.`,
    });
    if (created)
      await navigate({
        to: "/workspaces/$workspaceId/sessions/$sessionId",
        params: { workspaceId, sessionId: created.id },
      });
  };
  const newArtifact = canCreate ? (
    <Button
      type="button"
      onClick={() => void startSession()}
      disabled={context.busy}
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

type SiteTab = "site" | "versions" | "conversations" | "data";

export function ArtifactDetailRoute({
  embedded = false,
  ...props
}: {
  workspaceId: string;
  artifactId: string;
  fromSession?: string | undefined;
  embedded?: boolean;
}) {
  return embedded ? <EmbeddedSiteDetail {...props} /> : <ArtifactDetailPage {...props} />;
}

/** The session dock's Site view: the shared SiteView with console tool access. */
function EmbeddedSiteDetail({
  workspaceId,
  artifactId,
}: {
  workspaceId: string;
  artifactId: string;
}) {
  const { client } = useAppContext();
  const viewer = useConsoleSiteViewer();
  const toolBridge = useCallback<SiteToolBridgeFactory>(
    (site) => {
      const scope = { workspaceTools: client.tools.forWorkspace(workspaceId), workspaceId };
      return site
        ? createSiteToolBridge({
            ...scope,
            artifactId: site.artifactId,
            siteVersionId: site.siteVersionId,
            requestedTools: site.requestedTools,
          })
        : createSiteToolBridge(scope);
    },
    [client, workspaceId],
  );
  return (
    <SiteView
      client={client}
      workspaceId={workspaceId}
      siteId={artifactId}
      toolBridge={toolBridge}
      viewer={viewer}
      showTitle={false}
      archivedMessage="This Site is archived. Open it full-page to restore it."
    />
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
  const viewer = useConsoleSiteViewer();
  const [tab, setTab] = useState<SiteTab>("site");
  const [detail, setDetail] = useState<WorkspaceArtifactDetailResponse | null>(null);
  const [content, setContent] = useState<Pick<
    WorkspaceArtifactContentResponse,
    "html" | "versionId" | "requestedTools"
  > | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyVersion, setBusyVersion] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
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
  const requestedTools = content?.requestedTools ?? NO_SITE_TOOLS;
  const siteVersionId = content?.versionId;
  const siteToolBridge = useMemo<PublishedHtmlArtifactToolBridge | undefined>(() => {
    if (!siteVersionId) return undefined;
    return createSiteToolBridge({
      workspaceTools: context.client.tools.forWorkspace(workspaceId),
      workspaceId,
      artifactId,
      siteVersionId,
      requestedTools,
    });
  }, [artifactId, context.client, requestedTools, siteVersionId, workspaceId]);
  const startEditSession = async () => {
    if (!canPublish || !detail || detail.artifact.status === "archived") return;
    const artifact = detail.artifact;
    const created = await context.startSession(workspaceId, {
      text: `Help me edit the Site “${artifact.title}”: /workspaces/${workspaceId}/artifacts/${artifact.id}`,
    });
    if (created)
      await navigate({
        to: "/workspaces/$workspaceId/sessions/$sessionId",
        params: { workspaceId, sessionId: created.id },
      });
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
        description: nextError instanceof Error ? nextError.message : String(nextError),
      });
    } finally {
      setBusyVersion(null);
    }
  };
  const setSiteStatus = async (status: "active" | "archived") => {
    if (!canPublish) return false;
    const artifact = detail?.artifact;
    const currentVersion = artifact?.currentVersion;
    if (!artifact || !currentVersion || artifact.status === status) return true;
    setStatusBusy(true);
    try {
      await context.client.setWorkspaceArtifactStatus(workspaceId, artifactId, {
        status,
        expectedCurrentVersionId: currentVersion.id,
        reason: `${status === "archived" ? "Archived" : "Restored"} from Sites by ${context.authSession?.user?.name ?? "a workspace member"}`,
        idempotencyKey: crypto.randomUUID(),
      });
      invalidateArtifactCatalog(context.client, workspaceId);
      toast.success(status === "archived" ? "Site archived" : "Site restored");
      await load();
      return true;
    } catch (nextError) {
      toast.error(status === "archived" ? "Couldn't archive Site" : "Couldn't restore Site", {
        description: nextError instanceof Error ? nextError.message : String(nextError),
      });
      return false;
    } finally {
      setStatusBusy(false);
    }
  };
  const archived = detail?.artifact.status === "archived";
  // Site Data is for the people who manage the Site: its owner and workspace
  // admins. The API decides; an ownerless Site shows the tab and its answer.
  const manageData = Boolean(
    canPublish &&
    detail &&
    (hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin") ||
      !detail.artifact.ownerSubjectId ||
      detail.artifact.ownerSubjectId === context.accessContext.subjectId),
  );
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  // Publishing is for the same people as Site Data: the owner and workspace admins.
  const publication = useSitePublication({
    client: context.client,
    workspaceId,
    siteId: artifactId,
    enabled: manageData,
  });
  const setView = (view: ArtifactReturnSearch["view"]) =>
    void navigate({
      to: "/workspaces/$workspaceId/artifacts/$artifactId",
      params: { workspaceId, artifactId },
      search: { ...search, view },
    });
  // A Personal workspace has nobody to share with, so there is no audience.
  const showAudience = !isPersonalWorkspace(workspace, context.managedSelfContext);
  const audience = useSiteAudience({
    client: context.client,
    workspaceId,
    workspaceName: workspace?.name ?? "this workspace",
    artifact: detail?.artifact ?? PLACEHOLDER_SITE,
    ownedByCurrentUser: Boolean(
      canPublish &&
      detail?.artifact.ownerSubjectId &&
      detail.artifact.ownerSubjectId === context.accessContext.subjectId,
    ),
    onChanged: (artifact) => {
      setDetail((current) => (current ? { ...current, artifact } : current));
      invalidateArtifactCatalog(context.client, workspaceId);
    },
  });
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
  if (search.view === "publish")
    return (
      <ContentPage width="standard" className={ARTIFACT_DETAIL_FRAME}>
        <SitePublishPage
          client={context.client}
          workspaceId={workspaceId}
          workspaceName={workspace?.name ?? "this workspace"}
          site={artifact}
          load={publication.load}
          onPublication={publication.setPublication}
          onReload={() => void publication.reload()}
          onBack={() => setView(undefined)}
          canManage={manageData && !archived}
          isAdmin={hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin")}
          onShareWithWorkspace={showAudience ? audience.share : undefined}
          sites={sitesClientConfig(context.clientConfig)}
        />
        {showAudience ? audience.dialog : null}
      </ContentPage>
    );
  return (
    <ContentPage width="standard" className={ARTIFACT_DETAIL_FRAME}>
      <DetailPage back={back}>
        <LineTabs value={tab} onValueChange={(value) => setTab(value as SiteTab)}>
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
                    <SitePublishButton load={publication.load} onOpen={() => setView("publish")} />
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
                      onClick={() => void startEditSession()}
                      disabled={context.busy}
                      className="rounded-[10px] pointer-coarse:h-11"
                    >
                      <SparklesIcon aria-hidden="true" />
                      Edit with Opengeni
                    </Button>
                  )}
                  {archived ? null : (
                    <MoreMenu label={`More actions for ${artifact.title}`}>
                      <DropdownMenuItem
                        disabled={statusBusy}
                        onSelect={() => setArchiveDialogOpen(true)}
                      >
                        <ArchiveIcon />
                        Archive
                      </DropdownMenuItem>
                    </MoreMenu>
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
              </LineTabsList>
            }
          />
          <LineTabsContent value="site" className="pt-6">
            <div className="flex min-w-0 flex-col gap-4">
              {artifact.description ? (
                <p className="text-sm leading-5 text-fg-muted">{artifact.description}</p>
              ) : null}
              {archived ? (
                <Notice icon={<ArchiveIcon className="size-4" />} title="This Site is archived">
                  It's unpublished. Its source and versions are kept: restore it to edit it or bring
                  back an earlier version.
                </Notice>
              ) : null}
              {content ? (
                <ArtifactSandbox
                  html={content.html}
                  title={artifact.title}
                  versionLabel={
                    artifact.currentVersion ? `v${artifact.currentVersion.revision}` : undefined
                  }
                  editDisabled={context.busy || archived}
                  onEdit={canPublish ? () => void startEditSession() : undefined}
                  toolBridge={archived ? undefined : siteToolBridge}
                  viewer={viewer}
                  connectedToolCount={toolCount}
                />
              ) : (
                <Notice
                  tone="failed"
                  title="There's nothing to show for this Site"
                  actionLayout="responsive"
                  action={
                    <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
                      <RotateCcwIcon aria-hidden="true" />
                      Retry
                    </Button>
                  }
                >
                  It has no published version you can open. Try again, or ask whoever published it
                  to publish it again.
                </Notice>
              )}
            </div>
          </LineTabsContent>
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
        </LineTabs>
      </DetailPage>
      {showAudience ? audience.dialog : null}
      <ConfirmDialog
        open={archiveDialogOpen}
        onOpenChange={setArchiveDialogOpen}
        title={`Archive “${artifact.title}”?`}
        description="The Site will be unpublished, but its source and complete version history will remain recoverable."
        confirmLabel="Archive Site"
        cancelAutoFocus
        onConfirm={() => setSiteStatus("archived")}
      />
    </ContentPage>
  );
}
