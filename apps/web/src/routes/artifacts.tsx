import { ArtifactSessionPage } from "@/components/session/artifact-session-page";
import type {
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
import { Link, useNavigate } from "@tanstack/react-router";
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
import { artifactKinds, defaultArtifactFilters, type ArtifactKind } from "@/lib/artifact-catalog";
import { invalidateArtifactCatalog, useArtifactCatalog } from "@/lib/use-artifact-catalog";
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
import { createSiteToolBridge } from "@/lib/site-tool-bridge";
import { hasWorkspacePermission } from "@/lib/permissions";

const NO_SITE_TOOLS: readonly ToolGatewayIdentity[] = [];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SiteLoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
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
    <ArtifactSessionPage workspaceId={workspaceId} fromSession={fromSession}>
      <ArtifactDetailRoute
        key={`${workspaceId}:${artifactId}`}
        workspaceId={workspaceId}
        artifactId={artifactId}
        fromSession={fromSession}
      />
    </ArtifactSessionPage>
  ) : (
    <ArtifactSessionPage workspaceId={workspaceId} fromSession={fromSession}>
      <ArtifactListRoute key={workspaceId} workspaceId={workspaceId} />
    </ArtifactSessionPage>
  );
}

function ArtifactListRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const [filters, setFilters] = useState(defaultArtifactFilters);
  const [empty, setEmpty] = useState(false);
  const catalog = useArtifactCatalog(
    context.client,
    workspaceId,
    filters,
    context.accessKeyVersion,
  );
  const canCreate = hasWorkspacePermission(context.accessContext, workspaceId, "sessions:create");
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
    <ContentPage width="wide" className="max-w-[1200px] pt-6">
      <LineTabs
        value={filters.kind}
        onValueChange={(kind) => setFilters({ ...filters, kind: kind as ArtifactKind | "all" })}
        className="min-w-0"
      >
        <PageHeader
          icon={<PanelsTopLeftIcon />}
          title="Artifacts"
          description="Sites, images, documents and files made with Geni"
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
          />
        </LineTabsContent>
      </LineTabs>
    </ContentPage>
  );
}

type SiteTab = "site" | "versions" | "conversations";

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
  if (error) {
    return (
      <ContentPage width="standard" className={ARTIFACT_DETAIL_FRAME}>
        <DetailPage back={back}>
          <SiteLoadError error={error} onRetry={() => void load()} />
        </DetailPage>
      </ContentPage>
    );
  }
  if (!detail || !content) {
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
  const toolCount = content.requestedTools.length;
  return (
    <ContentPage width="standard" className={ARTIFACT_DETAIL_FRAME}>
      <DetailPage back={back}>
        <LineTabs value={tab} onValueChange={(value) => setTab(value as SiteTab)}>
          <DetailPageHeader
            leading={<ArtifactKindTile kind="site" />}
            title={artifact.title}
            chips={
              archived ? (
                <StatusBadge tone="neutral" icon="auto">
                  Archived
                </StatusBadge>
              ) : null
            }
            meta={[
              artifact.currentVersion ? `Version ${artifact.currentVersion.revision}` : null,
              toolCount > 0 ? `Uses ${toolCount} ${toolCount === 1 ? "tool" : "tools"}` : null,
              <RelativeTime key="updated" date={artifact.updatedAt} prefix="Updated" inSentence />,
            ]}
            actions={
              canPublish ? (
                <>
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
                      Edit with Geni
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
              <ArtifactSandbox
                html={content.html}
                title={artifact.title}
                versionLabel={
                  artifact.currentVersion ? `v${artifact.currentVersion.revision}` : undefined
                }
                editDisabled={context.busy || archived}
                onEdit={canPublish ? () => void startEditSession() : undefined}
                toolBridge={archived ? undefined : siteToolBridge}
                connectedToolCount={toolCount}
              />
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
                              className="relative z-10 font-medium text-fg-muted underline-offset-2 hover:text-fg hover:underline"
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
        </LineTabs>
      </DetailPage>
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
