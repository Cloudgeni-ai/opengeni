import { Link } from "@tanstack/react-router";
import type { ArtifactCatalogItem } from "@opengeni/sdk";
import { ArtifactViewerHeader } from "@opengeni/react/artifacts";
import {
  Loader2Icon,
  Maximize2Icon,
  PanelsTopLeftIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SettingsIcon,
} from "lucide-react";
import { lazy, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";
import { EditableArtifactRoute } from "@/routes/editable-artifact";
import { ArtifactLibrary, type ArtifactPinAction } from "@/components/artifacts/artifact-library";
import { defaultArtifactFilters, filterArtifactCatalog } from "@/lib/artifact-catalog";
import { hasWorkspacePermission } from "@/lib/permissions";
import { cn } from "@/lib/utils";
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
  onPin,
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
  onPin?: ArtifactPinAction;
}>) {
  const [selectedArtifactId, setSelectedArtifactId] = useState(
    () => initialSelectedArtifactId ?? artifacts[0]?.id ?? null,
  );
  const [browsing, setBrowsing] = useState(!initialSelectedArtifactId && !openArtifactRequest);
  const [filters, setFilters] = useState(defaultArtifactFilters);
  // A Site's Settings open in place of the Site, for the Site on screen only.
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  // The Site's reload and full screen live in this header, not a second
  // toolbar under it.
  const [siteReload, setSiteReload] = useState(0);
  const [fullScreenSite, setFullScreenSite] = useState<string | null>(null);
  const { accessContext } = useAppContext();
  const canManageSites = hasWorkspacePermission(accessContext, workspaceId, "artifacts:publish");
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
            <Link
              to="/workspaces/$workspaceId/artifacts"
              params={{ workspaceId }}
              search={sessionId ? { fromSession: sessionId } : {}}
            >
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
          onPin={onPin}
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

  const settingsOpen = artifact.modality === "site" && settingsFor === artifact.id;
  const settingsLabel = settingsOpen ? "Back to Site" : "Site settings";
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg text-fg">
      <ArtifactViewerHeader
        kind={artifact.modality}
        title={artifact.title}
        onBack={
          catalogItems.length > 0
            ? () => {
                setBrowsing(true);
                onSelectedArtifactIdChange?.(null);
              }
            : undefined
        }
        backLabel="Back to session artifacts"
        // One line: the icon already says what kind it is.
        subtitle=""
        actions={
          <>
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
            {artifact.modality === "site" && !settingsOpen ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label="Reload Site"
                  title="Reload Site"
                  onClick={() => setSiteReload((value) => value + 1)}
                >
                  <RotateCwIcon className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label="Open full screen"
                  title="Open full screen"
                  onClick={() => setFullScreenSite(artifact.id)}
                >
                  <Maximize2Icon className="size-4" />
                </Button>
              </>
            ) : null}
            {artifact.modality === "site" && canManageSites ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn("shrink-0", settingsOpen && "bg-accent text-accent-foreground")}
                aria-label={settingsLabel}
                aria-pressed={settingsOpen}
                title={settingsLabel}
                onClick={() => setSettingsFor(settingsOpen ? null : artifact.id)}
              >
                <SettingsIcon className="size-4" />
              </Button>
            ) : null}
          </>
        }
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {artifact.modality === "site" ? (
          <ArtifactDetailRoute
            key={`${artifact.id}:${artifact.versionId ?? ""}:${artifact.siteStatus ?? ""}`}
            workspaceId={workspaceId}
            artifactId={artifact.id}
            embedded
            embeddedView={settingsOpen ? "settings" : "site"}
            embeddedControls={{
              reloadToken: siteReload,
              fullScreen: fullScreenSite === artifact.id,
              onFullScreenChange: (next) => setFullScreenSite(next ? artifact.id : null),
            }}
          />
        ) : artifact.modality === "image" || artifact.modality === "file" ? (
          <RetainedArtifactRoute workspaceId={workspaceId} artifactId={artifact.id} embedded />
        ) : (
          <EditableArtifactRoute workspaceId={workspaceId} artifactId={artifact.id} embedded />
        )}
      </div>
    </div>
  );
}

function matchesArtifact(artifact: SessionEditableArtifactSummary, selected: string | null) {
  // A file-route request can arrive before the catalog classifies its image MIME.
  return (
    selected === `${artifact.modality}:${artifact.id}` ||
    selected === artifact.id ||
    (artifact.modality === "image" && selected === `file:${artifact.id}`)
  );
}
