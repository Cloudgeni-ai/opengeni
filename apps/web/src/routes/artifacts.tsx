import type {
  ToolGatewayIdentity,
  WorkspaceArtifactContentResponse,
  WorkspaceArtifactDetailResponse,
  WorkspaceArtifactListResponse,
  WorkspaceArtifactMutationResponse,
} from "@opengeni/sdk";
import type { PublishedHtmlArtifactToolBridge } from "@opengeni/react/artifacts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  Clock3Icon,
  FilesIcon,
  Globe2Icon,
  PanelsTopLeftIcon,
  PlugZapIcon,
  RotateCcwIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { request } from "@/api";
import { EmptyState, LoadErrorState, PageHeader } from "@/components/common";
import { ArtifactSandbox } from "@/components/artifacts/artifact-sandbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContentPage } from "@/components/ui/content-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import {
  ARTIFACT_CREATE_PERMISSIONS,
  ARTIFACT_CREATE_TOOLS,
  ARTIFACT_EDIT_PERMISSIONS,
  ARTIFACT_EDIT_TOOLS,
  applyNewSessionModelPreference,
  artifactCreateInstructions,
  artifactCreateOpeningMessage,
  artifactEditInstructions,
  artifactEditOpeningMessage,
} from "@/lib/artifact-authoring";
import { createSiteToolBridge } from "@/lib/site-tool-bridge";

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const NO_SITE_TOOLS: readonly ToolGatewayIdentity[] = [];

function useArtifacts(workspaceId: string) {
  const [data, setData] = useState<WorkspaceArtifactListResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setError(null);
      setData(
        await request<WorkspaceArtifactListResponse>(
          `/v1/workspaces/${workspaceId}/published-artifacts`,
        ),
      );
    } catch (nextError) {
      setError(nextError);
    }
  }, [workspaceId]);
  useEffect(() => void load(), [load]);
  return { data, error, load };
}

export function ArtifactsRoute({
  workspaceId,
  artifactId,
}: {
  workspaceId: string;
  artifactId?: string;
}) {
  return artifactId ? (
    <ArtifactDetailRoute
      key={`${workspaceId}:${artifactId}`}
      workspaceId={workspaceId}
      artifactId={artifactId}
    />
  ) : (
    <ArtifactListRoute workspaceId={workspaceId} />
  );
}

function ArtifactListRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const { data, error, load } = useArtifacts(workspaceId);
  const createWithGeni = async () => {
    const submission = await context.client
      .getNewSessionDraft(workspaceId)
      .then((draft) =>
        applyNewSessionModelPreference(
          {
            text: artifactCreateOpeningMessage(),
            firstPartyMcpPermissions: [...ARTIFACT_CREATE_PERMISSIONS],
            firstPartyMcpTools: [...ARTIFACT_CREATE_TOOLS],
          },
          draft,
        ),
      )
      .catch(() => ({
        text: artifactCreateOpeningMessage(),
        firstPartyMcpPermissions: [...ARTIFACT_CREATE_PERMISSIONS],
        firstPartyMcpTools: [...ARTIFACT_CREATE_TOOLS],
      }));
    const created = await context.startSession(workspaceId, submission, {
      instructions: artifactCreateInstructions(),
    });
    if (created)
      await navigate({
        to: "/workspaces/$workspaceId/sessions/$sessionId",
        params: { workspaceId, sessionId: created.id },
      });
  };
  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<PanelsTopLeftIcon className="size-4" />}
        title="Sites"
        description="Interactive pages, dashboards, and tools built for this workspace."
        actions={
          <Button onClick={() => void createWithGeni()} disabled={context.busy}>
            <SparklesIcon className="mr-2 size-4" />
            Build a Site
          </Button>
        }
      />
      {!data && !error ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : null}
      {error && !data ? (
        <LoadErrorState
          title="Couldn't load Sites"
          error={asError(error)}
          onRetry={() => void load()}
        />
      ) : null}
      {data?.artifacts.length === 0 ? (
        <EmptyState>
          No Sites yet. Ask Geni to build the first one for this workspace.
        </EmptyState>
      ) : null}
      {data?.artifacts.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.artifacts.map((artifact) => (
            <Link
              key={artifact.id}
              to="/workspaces/$workspaceId/artifacts/$artifactId"
              params={{ workspaceId, artifactId: artifact.id }}
              className="group rounded-xl border border-border bg-surface p-4 shadow-xs transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-brand/30 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="rounded-lg bg-brand/10 p-2.5 text-brand transition-colors group-hover:bg-brand/15">
                  <Globe2Icon className="size-4" />
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      artifact.status === "active" ? "secondary" : "outline"
                    }
                    className="text-2xs font-normal"
                  >
                    {artifact.status === "active" ? "Live" : "Archived"}
                  </Badge>
                  <span className="text-2xs text-fg-subtle">
                    {artifact.currentVersion
                      ? `v${artifact.currentVersion.revision}`
                      : "Draft"}
                  </span>
                </div>
              </div>
              <h2 className="mt-4 font-semibold text-fg">{artifact.title}</h2>
              <p className="mt-1 line-clamp-2 text-sm text-fg-muted">
                {artifact.description || "No description"}
              </p>
              <p className="mt-4 flex items-center gap-1 text-2xs text-fg-subtle">
                <Clock3Icon className="size-3" />
                {artifact.status === "archived" ? "Archived" : "Updated"}{" "}
                {formatDate(artifact.updatedAt)}
              </p>
            </Link>
          ))}
        </div>
      ) : null}
    </ContentPage>
  );
}

export function ArtifactDetailRoute({
  workspaceId,
  artifactId,
}: {
  workspaceId: string;
  artifactId: string;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<WorkspaceArtifactDetailResponse | null>(
    null,
  );
  const [content, setContent] =
    useState<WorkspaceArtifactContentResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyVersion, setBusyVersion] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const load = useCallback(async () => {
    try {
      setError(null);
      const basePath = `/v1/workspaces/${workspaceId}/published-artifacts/${encodeURIComponent(artifactId)}`;
      const [nextDetail, nextContent] = await Promise.all([
        request<WorkspaceArtifactDetailResponse>(basePath),
        request<WorkspaceArtifactContentResponse>(`${basePath}/content`),
      ]);
      setDetail(nextDetail);
      setContent(nextContent);
    } catch (nextError) {
      setError(nextError);
    }
  }, [artifactId, workspaceId]);
  useEffect(() => void load(), [load]);
  const requestedTools = content?.requestedTools ?? NO_SITE_TOOLS;
  const siteVersionId = content?.versionId;
  const siteToolBridge = useMemo<
    PublishedHtmlArtifactToolBridge | undefined
  >(() => {
    if (requestedTools.length === 0 || !siteVersionId) return undefined;
    return createSiteToolBridge({
      workspaceTools: context.client.tools.forWorkspace(workspaceId),
      workspaceId,
      artifactId,
      siteVersionId,
      requestedTools,
    });
  }, [artifactId, context.client, requestedTools, siteVersionId, workspaceId]);
  const editWithGeni = async () => {
    const currentVersion = detail?.artifact.currentVersion;
    if (!detail || !currentVersion || detail.artifact.status === "archived")
      return;
    const artifact = detail.artifact;
    const currentVersionId = currentVersion.id;
    const submission = await context.client
      .getNewSessionDraft(workspaceId)
      .then((draft) =>
        applyNewSessionModelPreference(
          {
            text: artifactEditOpeningMessage(artifact.title),
            firstPartyMcpPermissions: [...ARTIFACT_EDIT_PERMISSIONS],
            firstPartyMcpTools: [...ARTIFACT_EDIT_TOOLS],
          },
          draft,
        ),
      )
      .catch(() => ({
        text: artifactEditOpeningMessage(artifact.title),
        firstPartyMcpPermissions: [...ARTIFACT_EDIT_PERMISSIONS],
        firstPartyMcpTools: [...ARTIFACT_EDIT_TOOLS],
      }));
    const created = await context.startSession(workspaceId, submission, {
      instructions: artifactEditInstructions({
        artifactId: artifact.id,
        title: artifact.title,
        currentVersionId,
      }),
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
      !current ||
      current.id === versionId ||
      detail?.artifact.status === "archived"
    )
      return;
    setBusyVersion(versionId);
    try {
      await request<WorkspaceArtifactMutationResponse>(
        `/v1/workspaces/${workspaceId}/published-artifacts/${encodeURIComponent(artifactId)}/rollback`,
        {
          method: "POST",
          body: JSON.stringify({
            versionId,
            expectedCurrentVersionId: current.id,
            reason: `Restored from the artifact history by ${context.authSession?.user?.name ?? "a workspace member"}`,
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      toast.success("Artifact version restored");
      await load();
    } catch (nextError) {
      toast.error("Couldn't restore version", {
        description:
          nextError instanceof Error ? nextError.message : String(nextError),
      });
    } finally {
      setBusyVersion(null);
    }
  };
  const setSiteStatus = async (status: "active" | "archived") => {
    const artifact = detail?.artifact;
    const currentVersion = artifact?.currentVersion;
    if (!artifact || !currentVersion || artifact.status === status) return true;
    setStatusBusy(true);
    try {
      await request<WorkspaceArtifactMutationResponse>(
        `/v1/workspaces/${workspaceId}/published-artifacts/${encodeURIComponent(artifactId)}/status`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status,
            expectedCurrentVersionId: currentVersion.id,
            reason: `${status === "archived" ? "Archived" : "Restored"} from Sites by ${context.authSession?.user?.name ?? "a workspace member"}`,
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      toast.success(status === "archived" ? "Site archived" : "Site restored");
      await load();
      return true;
    } catch (nextError) {
      toast.error(
        status === "archived"
          ? "Couldn't archive Site"
          : "Couldn't restore Site",
        {
          description:
            nextError instanceof Error ? nextError.message : String(nextError),
        },
      );
      return false;
    } finally {
      setStatusBusy(false);
    }
  };
  const archived = detail?.artifact.status === "archived";
  return (
    <ContentPage width="wide">
      <div className="mb-5 border-b border-border pb-5">
        <Link
          to="/workspaces/$workspaceId/artifacts"
          params={{ workspaceId }}
          className="mb-3 inline-flex w-fit items-center gap-1.5 text-xs font-medium text-fg-subtle transition-colors hover:text-fg"
        >
          <ArrowLeftIcon className="size-3.5" />
          All Sites
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
                <Badge
                  variant="outline"
                  className="h-5 rounded-md px-1.5 text-2xs font-normal"
                >
                  v{detail.artifact.currentVersion.revision}
                </Badge>
              ) : null}
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-5 text-fg-muted">
              {detail?.artifact.description ?? "An interactive workspace Site."}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {archived ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void setSiteStatus("active")}
                disabled={!detail || statusBusy}
              >
                <ArchiveRestoreIcon className="mr-2 size-4" />
                {statusBusy ? "Restoring…" : "Restore Site"}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setArchiveDialogOpen(true)}
                disabled={!detail || statusBusy}
              >
                <ArchiveIcon className="mr-2 size-4" />
                Archive
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => void editWithGeni()}
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
                  <p className="text-sm font-medium text-fg">
                    This Site is archived
                  </p>
                  <p className="mt-0.5 text-xs text-fg-muted">
                    Its source and versions are retained. Restore it before
                    editing or rolling back.
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
            onEdit={() => void editWithGeni()}
            toolBridge={archived ? undefined : siteToolBridge}
            connectedToolCount={content.requestedTools.length}
            sourceFileCount={content.source.files.length}
          />
          <section className="overflow-hidden rounded-2xl border border-border/80 bg-surface/60 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/80 px-4 py-3.5 sm:px-5">
              <div>
                <h2 className="text-sm font-semibold text-fg">
                  Version history
                </h2>
                <p className="mt-0.5 text-xs text-fg-muted">
                  Restore an earlier version without losing the current source.
                </p>
              </div>
              <div className="flex items-center gap-3 text-2xs text-fg-subtle">
                <span className="inline-flex items-center gap-1">
                  <FilesIcon className="size-3" />
                  {content.source.files.length} source{" "}
                  {content.source.files.length === 1 ? "file" : "files"}
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
                const current =
                  detail.artifact.currentVersion?.id === version.id;
                return (
                  <div
                    key={version.id}
                    className="flex min-h-16 items-center justify-between gap-4 py-3 text-sm"
                  >
                    <div>
                      <span className="font-medium text-fg">
                        Version {version.revision}
                      </span>
                      {current ? (
                        <span className="ml-2 rounded-full bg-status-success/10 px-2 py-0.5 text-2xs font-medium text-status-success">
                          Current
                        </span>
                      ) : null}
                      <p className="mt-1 text-xs text-fg-subtle">
                        {formatDate(version.createdAt)} ·{" "}
                        {(version.sizeBytes / 1024).toFixed(1)} KB
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
                              {version.revision === 1
                                ? "Creation session"
                                : "Publishing session"}
                            </Link>
                          </>
                        ) : null}
                      </p>
                    </div>
                    {!current ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyVersion !== null || archived}
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
