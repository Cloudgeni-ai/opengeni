import { Link } from "@tanstack/react-router";
import {
  FilePenLineIcon,
  GalleryHorizontalEndIcon,
  Loader2Icon,
  Maximize2Icon,
  PanelsTopLeftIcon,
  RefreshCwIcon,
  Table2Icon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { EditableArtifactRoute } from "@/routes/editable-artifact";

export type SessionEditableArtifactSummary = Readonly<{
  id: string;
  modality: "document" | "spreadsheet" | "presentation";
  title: string;
}>;

export type SessionEditableArtifactsStatus = "loading" | "ready" | "error";

export function SessionEditableArtifactsWorkspace({
  workspaceId,
  artifacts,
  status,
  onRetry,
}: Readonly<{
  workspaceId: string;
  artifacts: readonly SessionEditableArtifactSummary[];
  status: SessionEditableArtifactsStatus;
  onRetry: () => void;
}>) {
  const [selectedArtifactId, setSelectedArtifactId] = useState(() => artifacts[0]?.id ?? null);

  useEffect(() => {
    setSelectedArtifactId((current) => {
      if (current && artifacts.some((artifact) => artifact.id === current)) {
        return current;
      }
      return artifacts[0]?.id ?? null;
    });
  }, [artifacts]);

  const artifact =
    artifacts.find((candidate) => candidate.id === selectedArtifactId) ?? artifacts[0];
  if (!artifact) {
    const loading = status === "loading";
    const failed = status === "error";
    return (
      <div
        className="flex h-full min-h-0 items-center justify-center bg-bg px-6 text-center text-fg"
        {...(loading ? { role: "status" as const } : failed ? { role: "alert" as const } : {})}
      >
        <div className="flex max-w-72 flex-col items-center">
          <span className="mb-3 flex size-10 items-center justify-center rounded-xl bg-accent text-accent-foreground">
            {loading ? (
              <Loader2Icon className="size-4 animate-spin" aria-hidden />
            ) : failed ? (
              <RefreshCwIcon className="size-4" aria-hidden />
            ) : (
              <PanelsTopLeftIcon className="size-4" aria-hidden />
            )}
          </span>
          <p className="text-sm font-medium">
            {loading ? "Loading artifacts" : failed ? "Artifacts unavailable" : "No artifacts yet"}
          </p>
          <p className="mt-1 text-xs leading-5 text-fg-subtle">
            {loading
              ? "Opening the shared workspace."
              : failed
                ? "The shared workspace could not be loaded."
                : "Ask the agent to create or import a document, spreadsheet, or presentation."}
          </p>
          {failed ? (
            <Button type="button" variant="outline" size="sm" className="mt-4" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg text-fg">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
          {artifactIcon(artifact.modality)}
        </span>
        {artifacts.length > 1 ? (
          <div className="min-w-0 flex-1 [&>span]:block [&>span]:w-full">
            <Select
              aria-label="Choose editable artifact"
              className="h-8 min-w-0 border-0 bg-transparent pl-1 font-medium shadow-none"
              value={artifact.id}
              onChange={(event) => setSelectedArtifactId(event.target.value)}
            >
              {artifacts.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{artifact.title}</p>
            <p className="truncate text-xs capitalize text-fg-subtle">
              {artifact.modality} · shared editor
            </p>
          </div>
        )}
        {status === "error" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label="Retry artifact list"
            title="Retry artifact list"
            onClick={onRetry}
          >
            <RefreshCwIcon className="size-4" />
          </Button>
        ) : null}
        <Button
          asChild
          variant="ghost"
          size="icon-sm"
          className="ml-auto shrink-0"
          title="Open full-page editor"
        >
          <Link
            to="/workspaces/$workspaceId/artifacts/editable/$artifactId"
            params={{ workspaceId, artifactId: artifact.id }}
            aria-label={`Open ${artifact.title} in the full-page editor`}
          >
            <Maximize2Icon className="size-4" />
          </Link>
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <EditableArtifactRoute workspaceId={workspaceId} artifactId={artifact.id} />
      </div>
    </div>
  );
}

function artifactIcon(modality: "document" | "spreadsheet" | "presentation"): ReactNode {
  if (modality === "document") return <FilePenLineIcon className="size-4" />;
  if (modality === "spreadsheet") return <Table2Icon className="size-4" />;
  return <GalleryHorizontalEndIcon className="size-4" />;
}
