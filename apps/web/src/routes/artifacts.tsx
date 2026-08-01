import type {
  WorkspaceArtifactContentResponse,
  WorkspaceArtifactDetailResponse,
  WorkspaceArtifactListResponse,
  WorkspaceArtifactMutationResponse,
} from "@opengeni/sdk";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  Clock3Icon,
  Code2Icon,
  PanelsTopLeftIcon,
  RotateCcwIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { request } from "@/api";
import { EmptyState, LoadErrorState, PageHeader } from "@/components/common";
import { ArtifactSandbox } from "@/components/artifacts/artifact-sandbox";
import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import {
  ARTIFACT_CREATE_PERMISSIONS,
  ARTIFACT_CREATE_TOOLS,
  ARTIFACT_EDIT_PERMISSIONS,
  ARTIFACT_EDIT_TOOLS,
  ARTIFACT_SESSION_TOOLS,
  applyNewSessionModelPreference,
  artifactCreateInstructions,
  artifactCreateOpeningMessage,
  artifactEditInstructions,
  artifactEditOpeningMessage,
} from "@/lib/artifact-authoring";

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

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
    <ArtifactDetailRoute workspaceId={workspaceId} artifactId={artifactId} />
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
      sessionTools: [...ARTIFACT_SESSION_TOOLS],
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
        title="Artifacts"
        description="Pages, visualizations, and other HTML/CSS experiences created in this workspace."
        actions={
          <Button onClick={() => void createWithGeni()} disabled={context.busy}>
            <SparklesIcon className="mr-2 size-4" />
            Create with Geni
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
          title="Couldn't load artifacts"
          error={asError(error)}
          onRetry={() => void load()}
        />
      ) : null}
      {data?.artifacts.length === 0 ? (
        <EmptyState>
          No artifacts yet. Ask Geni to build the first one for this workspace.
        </EmptyState>
      ) : null}
      {data?.artifacts.length ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.artifacts.map((artifact) => (
            <Link
              key={artifact.id}
              to="/workspaces/$workspaceId/artifacts/$artifactId"
              params={{ workspaceId, artifactId: artifact.id }}
              className="rounded-lg border border-border bg-surface p-4 transition hover:bg-surface-2/40"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="rounded-md bg-brand/10 p-2 text-brand">
                  <Code2Icon className="size-4" />
                </div>
                <span className="text-2xs text-fg-subtle">
                  {artifact.currentVersion ? `v${artifact.currentVersion.revision}` : "Draft"}
                </span>
              </div>
              <h2 className="mt-4 font-semibold text-fg">{artifact.title}</h2>
              <p className="mt-1 line-clamp-2 text-sm text-fg-muted">
                {artifact.description || "No description"}
              </p>
              <p className="mt-4 flex items-center gap-1 text-2xs text-fg-subtle">
                <Clock3Icon className="size-3" />
                Updated {formatDate(artifact.updatedAt)}
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
  const [detail, setDetail] = useState<WorkspaceArtifactDetailResponse | null>(null);
  const [content, setContent] = useState<WorkspaceArtifactContentResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyVersion, setBusyVersion] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setError(null);
      const basePath = `/v1/workspaces/${workspaceId}/published-artifacts/${encodeURIComponent(artifactId)}`;
      const nextDetail = await request<WorkspaceArtifactDetailResponse>(basePath);
      setDetail(nextDetail);
      setContent(await request<WorkspaceArtifactContentResponse>(`${basePath}/content`));
    } catch (nextError) {
      setError(nextError);
    }
  }, [artifactId, workspaceId]);
  useEffect(() => void load(), [load]);
  const editWithGeni = async () => {
    const currentVersion = detail?.artifact.currentVersion;
    if (!detail || !currentVersion) return;
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
      sessionTools: [...ARTIFACT_SESSION_TOOLS],
    });
    if (created)
      await navigate({
        to: "/workspaces/$workspaceId/sessions/$sessionId",
        params: { workspaceId, sessionId: created.id },
      });
  };
  const rollback = async (versionId: string) => {
    const current = detail?.artifact.currentVersion;
    if (!current || current.id === versionId) return;
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
        description: nextError instanceof Error ? nextError.message : String(nextError),
      });
    } finally {
      setBusyVersion(null);
    }
  };
  return (
    <ContentPage width="wide">
      <Link
        to="/workspaces/$workspaceId/artifacts"
        params={{ workspaceId }}
        className="mb-4 inline-flex w-fit items-center gap-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back to artifacts
      </Link>
      <PageHeader
        icon={<PanelsTopLeftIcon className="size-4" />}
        title={detail?.artifact.title ?? "Artifact"}
        description={detail?.artifact.description ?? "A workspace HTML/CSS artifact."}
        actions={
          <Button onClick={() => void editWithGeni()} disabled={!detail || context.busy}>
            <SparklesIcon className="mr-2 size-4" />
            Edit with Geni
          </Button>
        }
      />
      {!detail && !error ? <Skeleton className="h-96 w-full" /> : null}
      {error ? (
        <LoadErrorState
          title="Couldn't load artifact"
          error={asError(error)}
          onRetry={() => void load()}
        />
      ) : null}
      {detail && content ? (
        <div className="grid gap-5">
          <ArtifactSandbox
            html={content.html}
            title={detail.artifact.title}
            versionLabel={
              detail.artifact.currentVersion
                ? `v${detail.artifact.currentVersion.revision}`
                : undefined
            }
            editDisabled={context.busy}
            onEdit={() => void editWithGeni()}
          />
          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold text-fg">Version history</h2>
            <div className="mt-3 divide-y divide-border">
              {detail.versions.map((version) => {
                const current = detail.artifact.currentVersion?.id === version.id;
                return (
                  <div
                    key={version.id}
                    className="flex items-center justify-between gap-4 py-3 text-sm"
                  >
                    <div>
                      <span className="font-medium text-fg">Version {version.revision}</span>
                      {current ? (
                        <span className="ml-2 rounded-full bg-brand/10 px-2 py-0.5 text-2xs text-brand">
                          Current
                        </span>
                      ) : null}
                      <p className="mt-1 text-xs text-fg-subtle">
                        {formatDate(version.createdAt)} · {(version.sizeBytes / 1024).toFixed(1)} KB
                      </p>
                    </div>
                    {!current ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyVersion !== null}
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
    </ContentPage>
  );
}
