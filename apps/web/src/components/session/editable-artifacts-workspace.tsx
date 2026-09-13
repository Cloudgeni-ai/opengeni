import { Link } from "@tanstack/react-router";
import type { ArtifactCatalogItem } from "@opengeni/sdk";
import {
  FilePenLineIcon,
  GalleryHorizontalEndIcon,
  Loader2Icon,
  Maximize2Icon,
  PanelsTopLeftIcon,
  RefreshCwIcon,
  Table2Icon,
  ArrowLeftIcon,
  FileIcon,
  ImageIcon,
} from "lucide-react";
import { lazy, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { EditableArtifactRoute } from "@/routes/editable-artifact";
import { ArtifactLibrary } from "@/components/artifacts/artifact-library";
import {
  artifactRoute,
  defaultArtifactFilters,
  filterArtifactCatalog,
} from "@/lib/artifact-catalog";
const RetainedArtifactRoute = lazy(() =>
  import("@/routes/retained-artifact").then((module) => ({
    default: module.RetainedArtifactRoute,
  })),
);
const ArtifactDetailRoute = lazy(() =>
  import("@/routes/artifacts").then((module) => ({ default: module.ArtifactDetailRoute })),
);

export type SessionEditableArtifactSummary = Readonly<{
  id: string;
  modality: "document" | "spreadsheet" | "presentation" | "site" | "image" | "file";
  title: string;
  versionId?: string;
  siteStatus?: "active" | "archived";
  catalogItem?: ArtifactCatalogItem;
}>;

export type SessionEditableArtifactsStatus = "loading" | "ready" | "error";

export function SessionEditableArtifactsWorkspace({
  workspaceId,
  sessionId,
  artifacts,
  status,
  onRetry,
  initialSelectedArtifactId,
  openArtifactRequest,
  onSelectedArtifactIdChange,
}: Readonly<{
  workspaceId: string;
  sessionId?: string;
  artifacts: readonly SessionEditableArtifactSummary[];
  status: SessionEditableArtifactsStatus;
  onRetry: () => void;
  initialSelectedArtifactId?: string | null;
  openArtifactRequest?: {
    artifactId: string;
    artifactKind?: SessionEditableArtifactSummary["modality"];
    requestId: number;
  } | null;
  onSelectedArtifactIdChange?: (artifactId: string | null) => void;
}>) {
  const [selectedArtifactId, setSelectedArtifactId] = useState(
    () => initialSelectedArtifactId ?? artifacts[0]?.id ?? null,
  );
  const [browsing, setBrowsing] = useState(!initialSelectedArtifactId && !openArtifactRequest);
  const [filters, setFilters] = useState(defaultArtifactFilters);
  const catalogItems = artifacts.flatMap((item) => (item.catalogItem ? [item.catalogItem] : []));

  const handledRequestId = useRef<number | null>(null);
  useEffect(() => {
    // Consume navigation before reconciling a selection whose synthetic summary
    // may have been replaced by this request. Later renders preserve manual choices.
    if (openArtifactRequest && handledRequestId.current !== openArtifactRequest.requestId) {
      handledRequestId.current = openArtifactRequest.requestId;
      const selected = openArtifactRequest.artifactKind
        ? `${openArtifactRequest.artifactKind}:${openArtifactRequest.artifactId}`
        : openArtifactRequest.artifactId;
      setSelectedArtifactId(selected);
      setBrowsing(false);
      onSelectedArtifactIdChange?.(selected);
      return;
    }
    if (status === "loading") return;
    // Discovery must not turn passive browsing into a remembered editor selection.
    if (browsing && catalogItems.length > 0) return;
    if (
      selectedArtifactId &&
      artifacts.some((artifact) => matchesArtifact(artifact, selectedArtifactId))
    ) {
      return;
    }
    const next = artifacts[0]?.id ?? null;
    setSelectedArtifactId(next);
    onSelectedArtifactIdChange?.(next);
  }, [
    artifacts,
    browsing,
    catalogItems.length,
    openArtifactRequest,
    onSelectedArtifactIdChange,
    selectedArtifactId,
    status,
  ]);

  const artifact =
    artifacts.find((candidate) => matchesArtifact(candidate, selectedArtifactId)) ?? artifacts[0];
  if (browsing && catalogItems.length > 0) {
    return (
      <div className="@container h-full min-h-0 overflow-y-auto bg-bg p-3 text-fg">
        <div className="mb-4 flex min-h-10 items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Session artifacts</h2>
          <Button asChild variant="ghost" size="sm">
            <Link to="/workspaces/$workspaceId/artifacts" params={{ workspaceId }}>
              All artifacts
            </Link>
          </Button>
        </div>
        <ArtifactLibrary
          workspaceId={workspaceId}
          sessionId={sessionId}
          compact
          items={filterArtifactCatalog(catalogItems, filters)}
          filters={filters}
          onFiltersChange={setFilters}
          loading={status === "loading"}
          error={status === "error" ? new Error("The artifact list could not be refreshed.") : null}
          onRetry={onRetry}
          onSelect={(item) => {
            const key = `${item.kind}:${item.id}`;
            setSelectedArtifactId(key);
            setBrowsing(false);
            onSelectedArtifactIdChange?.(key);
          }}
        />
      </div>
    );
  }
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
                : "Ask the agent to create or import a Site, image, document, spreadsheet, or presentation."}
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
        {catalogItems.length > 0 ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Browse session artifacts"
            onClick={() => {
              setBrowsing(true);
              onSelectedArtifactIdChange?.(null);
            }}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
        ) : null}
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
          {artifactIcon(artifact.modality)}
        </span>
        {artifacts.length > 1 ? (
          <div className="min-w-0 flex-1 [&>span]:block [&>span]:w-full">
            <Select
              aria-label="Choose artifact"
              className="h-8 min-w-0 border-0 bg-transparent pl-1 font-medium shadow-none"
              value={artifact.catalogItem ? `${artifact.modality}:${artifact.id}` : artifact.id}
              onChange={(event) => {
                setSelectedArtifactId(event.target.value);
                onSelectedArtifactIdChange?.(event.target.value);
              }}
            >
              {artifacts.map((candidate) => (
                <option
                  key={`${candidate.modality}:${candidate.id}`}
                  value={
                    candidate.catalogItem ? `${candidate.modality}:${candidate.id}` : candidate.id
                  }
                >
                  {candidate.title}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{artifact.title}</p>
            <p className="truncate text-xs capitalize text-fg-subtle">
              {artifact.modality === "site"
                ? "Site · published preview"
                : artifact.modality === "image" || artifact.modality === "file"
                  ? `${artifact.modality} · retained file`
                  : `${artifact.modality} · shared editor`}
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
          title={artifact.modality === "site" ? "Open Site" : "Open full-page editor"}
        >
          <Link
            to={artifactRoute(artifact.modality)}
            params={{ workspaceId, artifactId: artifact.id }}
            search={sessionId ? { fromSession: sessionId } : {}}
            aria-label={`Open ${artifact.title} full-page`}
          >
            <Maximize2Icon className="size-4" />
          </Link>
        </Button>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {artifact.modality === "site" ? (
          <ArtifactDetailRoute
            key={`${artifact.id}:${artifact.versionId ?? ""}:${artifact.siteStatus ?? ""}`}
            workspaceId={workspaceId}
            artifactId={artifact.id}
            embedded
          />
        ) : artifact.modality === "image" || artifact.modality === "file" ? (
          <RetainedArtifactRoute workspaceId={workspaceId} artifactId={artifact.id} embedded />
        ) : (
          <EditableArtifactRoute workspaceId={workspaceId} artifactId={artifact.id} />
        )}
      </div>
    </div>
  );
}

function artifactIcon(modality: SessionEditableArtifactSummary["modality"]): ReactNode {
  if (modality === "image") return <ImageIcon className="size-4" />;
  if (modality === "file") return <FileIcon className="size-4" />;
  if (modality === "site") return <PanelsTopLeftIcon className="size-4" />;
  if (modality === "document") return <FilePenLineIcon className="size-4" />;
  if (modality === "spreadsheet") return <Table2Icon className="size-4" />;
  return <GalleryHorizontalEndIcon className="size-4" />;
}

function matchesArtifact(artifact: SessionEditableArtifactSummary, selected: string | null) {
  // A file-route request can arrive before the catalog classifies its image MIME.
  return (
    selected === `${artifact.modality}:${artifact.id}` ||
    selected === artifact.id ||
    (artifact.modality === "image" && selected === `file:${artifact.id}`)
  );
}
