import { ArtifactSessionPage } from "@/components/session/artifact-session-page";
import type {
  ToolGatewayIdentity,
  WorkspaceArtifactContentResponse,
  WorkspaceArtifactDetailResponse,
} from "@opengeni/sdk";
import type { PublishedHtmlArtifactToolBridge } from "@opengeni/react/artifacts";
import { loadSiteSnapshot } from "@opengeni/react/sites";
import { SiteConversations } from "@/components/artifacts/site-conversations";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  FilesIcon,
  PanelsTopLeftIcon,
  PlugZapIcon,
  RotateCcwIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { LoadErrorState, PageHeader } from "@/components/common";
import { ArtifactLibrary } from "@/components/artifacts/artifact-library";
import { defaultArtifactFilters } from "@/lib/artifact-catalog";
import { useArtifactCatalog } from "@/lib/use-artifact-catalog";
import { ArtifactSandbox } from "@/components/artifacts/artifact-sandbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContentPage } from "@/components/ui/content-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import { createSiteToolBridge } from "@/lib/site-tool-bridge";
import { hasWorkspacePermission } from "@/lib/permissions";

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const NO_SITE_TOOLS: readonly ToolGatewayIdentity[] = [];

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
      />
    </ArtifactSessionPage>
  ) : (
    <ArtifactListRoute key={workspaceId} workspaceId={workspaceId} />
  );
}

function ArtifactListRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const [filters, setFilters] = useState(defaultArtifactFilters);
  const catalog = useArtifactCatalog(
    context.client,
    workspaceId,
    filters,
    context.accessKeyVersion,
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
  return (
    <ContentPage width="wide">
      <PageHeader
        icon={<PanelsTopLeftIcon className="size-4" />}
        title="Artifacts"
        description="Sites, images, documents, and files created with Geni."
        actions={
          <Button onClick={() => void startSession()} disabled={context.busy}>
            <SparklesIcon className="mr-2 size-4" />
            New artifact
          </Button>
        }
      />
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
      />
    </ContentPage>
  );
}

export function ArtifactDetailRoute({
  workspaceId,
  artifactId,
  embedded = false,
}: {
  workspaceId: string;
  artifactId: string;
  embedded?: boolean;
}) {
  const context = useAppContext();
  const canPublish = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "artifacts:publish",
  );
  const navigate = useNavigate();
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
    if (!detail || detail.artifact.status === "archived") return;
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
  if (embedded) {
    if (error)
      return (
        <LoadErrorState
          title="Couldn't load Site"
          error={asError(error)}
          onRetry={() => void load()}
        />
      );
    if (!detail || !content)
      return (
        <div role="status" className="p-4 text-sm text-fg-muted">
          Loading Site…
        </div>
      );
    if (archived)
      return (
        <div className="p-4 text-sm text-fg-muted">
          This Site is archived. Open it full-page to restore it.
        </div>
      );
    return (
      <ArtifactSandbox
        html={content.html}
        title={detail.artifact.title}
        versionLabel={`v${detail.artifact.currentVersion?.revision}`}
        toolBridge={siteToolBridge}
        connectedToolCount={content.requestedTools.length}
        fill
        className="h-full rounded-none border-0"
      />
    );
  }
  return (
    <ContentPage width="wide">
      <div className="mb-5 border-b border-border pb-5">
        <Link
          to="/workspaces/$workspaceId/artifacts"
          params={{ workspaceId }}
          className="mb-3 inline-flex w-fit items-center gap-1.5 text-xs font-medium text-fg-subtle transition-colors hover:text-fg"
        >
          <ArrowLeftIcon className="size-3.5" />
          All artifacts
        </Link>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
                <PanelsTopLeftIcon className="size-4" />
              </span>
              <h1 className="truncate text-xl font-semibold tracking-tight text-fg">
                {detail?.artifact.title ?? "Site"}
              </h1>
              {detail?.artifact.currentVersion ? (
                <Badge variant="outline" className="h-5 rounded-md px-1.5 text-2xs font-normal">
                  v{detail.artifact.currentVersion.revision}
                </Badge>
              ) : null}
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-5 text-fg-muted">
              {detail?.artifact.description ?? "An interactive workspace Site."}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <SiteConversations
              key={artifactId}
              workspaceId={workspaceId}
              siteId={artifactId}
              title={detail?.artifact.title ?? "this Site"}
            />
            {archived ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void setSiteStatus("active")}
                disabled={!canPublish || !detail || statusBusy}
              >
                <ArchiveRestoreIcon className="mr-2 size-4" />
                {statusBusy ? "Restoring…" : "Restore Site"}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setArchiveDialogOpen(true)}
                disabled={!canPublish || !detail || statusBusy}
              >
                <ArchiveIcon className="mr-2 size-4" />
                Archive
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => void startEditSession()}
              disabled={!detail || context.busy || archived}
            >
              <SparklesIcon className="mr-2 size-4" />
              Edit with Geni
            </Button>
          </div>
        </div>
      </div>
      {!detail && !error ? <Skeleton className="h-96 w-full" /> : null}
      {error ? (
        <LoadErrorState
          title="Couldn't load Site"
          error={asError(error)}
          onRetry={() => void load()}
        />
      ) : null}
      {detail && content ? (
        <div className="grid gap-6">
          {archived ? (
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <ArchiveIcon className="mt-0.5 size-4 shrink-0 text-fg-muted" />
                <div>
                  <p className="text-sm font-medium text-fg">This Site is archived</p>
                  <p className="mt-0.5 text-xs text-fg-muted">
                    Its source and versions are retained. Restore it before editing or rolling back.
                  </p>
                </div>
              </div>
            </div>
          ) : null}
          <ArtifactSandbox
            html={content.html}
            title={detail.artifact.title}
            versionLabel={
              detail.artifact.currentVersion
                ? `v${detail.artifact.currentVersion.revision}`
                : undefined
            }
            editDisabled={context.busy || archived}
            onEdit={() => void startEditSession()}
            toolBridge={archived ? undefined : siteToolBridge}
            connectedToolCount={content.requestedTools.length}
          />
          <section className="overflow-hidden rounded-2xl border border-border/80 bg-surface/60 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/80 px-4 py-3.5 sm:px-5">
              <div>
                <h2 className="text-sm font-semibold text-fg">Version history</h2>
                <p className="mt-0.5 text-xs text-fg-muted">
                  Restore an earlier version without losing the current source.
                </p>
              </div>
              <div className="flex items-center gap-3 text-2xs text-fg-subtle">
                <span className="inline-flex items-center gap-1">
                  <FilesIcon className="size-3" />
                  {detail.artifact.currentVersion?.sourceSizeBytes ? "Source saved" : "HTML-only"}
                </span>
                <span className="inline-flex items-center gap-1">
                  <PlugZapIcon className="size-3" />
                  {content.requestedTools.length}{" "}
                  {content.requestedTools.length === 1 ? "tool" : "tools"}
                </span>
              </div>
            </div>
            <div className="divide-y divide-border/80 px-4 sm:px-5">
              {detail.versions.map((version) => {
                const current = detail.artifact.currentVersion?.id === version.id;
                return (
                  <div
                    key={version.id}
                    className="flex min-h-16 items-center justify-between gap-4 py-3 text-sm"
                  >
                    <div>
                      <span className="font-medium text-fg">Version {version.revision}</span>
                      {current ? (
                        <span className="ml-2 rounded-full bg-status-success/10 px-2 py-0.5 text-2xs font-medium text-status-success">
                          Current
                        </span>
                      ) : null}
                      <p className="mt-1 text-xs text-fg-subtle">
                        {formatDate(version.createdAt)} · {(version.sizeBytes / 1024).toFixed(1)} KB
                        {version.sourceSessionId ? (
                          <>
                            {" · "}
                            <Link
                              to="/workspaces/$workspaceId/sessions/$sessionId"
                              params={{
                                workspaceId,
                                sessionId: version.sourceSessionId,
                              }}
                              className="font-medium text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                            >
                              {version.revision === 1 ? "Creation session" : "Publishing session"}
                            </Link>
                          </>
                        ) : null}
                      </p>
                    </div>
                    {!current ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canPublish || busyVersion !== null || archived}
                        onClick={() => void rollback(version.id)}
                      >
                        <RotateCcwIcon className="mr-2 size-3.5" />
                        {busyVersion === version.id ? "Restoring…" : "Restore"}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}
      <ConfirmDialog
        open={archiveDialogOpen}
        onOpenChange={setArchiveDialogOpen}
        title={`Archive “${detail?.artifact.title ?? "this Site"}”?`}
        description="The Site will be unpublished, but its source and complete version history will remain recoverable."
        confirmLabel="Archive Site"
        cancelAutoFocus
        onConfirm={() => setSiteStatus("archived")}
      />
    </ContentPage>
  );
}
