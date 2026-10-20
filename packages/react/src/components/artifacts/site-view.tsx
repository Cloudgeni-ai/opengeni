import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SiteViewer } from "@opengeni/sdk";

import { loadSiteSnapshot } from "../../sites-ui";
import {
  ArtifactLoading,
  ArtifactProblem,
  artifactLoadErrorView,
  useArtifactLabels,
} from "./artifact-chrome";
import { ArtifactSandbox } from "./artifact-sandbox";
import type { SiteSnapshotClient, SiteToolBridgeFactory } from "./chat-interactive-block";
import { useOpenGeniText } from "../../messages/runtime";

type Snapshot = Awaited<ReturnType<typeof loadSiteSnapshot>>;

export type SiteViewProps = {
  client: SiteSnapshotClient;
  workspaceId: string;
  siteId: string;
  /** Host-owned Site API access. Omit it and the Site renders without workspace tools. */
  toolBridge?: SiteToolBridgeFactory | undefined;
  /** Who is viewing, answered to the Site's `site.viewer`. */
  viewer?: SiteViewer | undefined;
  theme?: "light" | "dark" | undefined;
  /** Shown instead of the archived notice; the console links to its full page. */
  archivedMessage?: string | undefined;
  /** Show the Site title in the frame bar; hide it under a host header that already does. */
  showTitle?: boolean | undefined;
  /** Loading copy; defaults to "Loading Site…". */
  loadingLabel?: string | undefined;
  /** Called with the loaded title, for a host header. */
  onTitle?: ((title: string) => void) | undefined;
  /** Hide the frame toolbar under a host header that draws reload and full screen. */
  showToolbar?: boolean | undefined;
  /** Reload the Site whenever this changes. */
  reloadToken?: number | undefined;
  /** Host-controlled full screen; omit to let the frame manage it. */
  fullScreen?: boolean | undefined;
  onFullScreenChange?: ((fullScreen: boolean) => void) | undefined;
  className?: string | undefined;
};

/**
 * A published Site filling its container: the console's session dock and an
 * embedding host's artifact viewer render the same view.
 */
export function SiteView({
  client,
  workspaceId,
  siteId,
  toolBridge,
  viewer,
  theme,
  archivedMessage,
  showTitle = true,
  loadingLabel,
  onTitle,
  showToolbar,
  reloadToken,
  fullScreen,
  onFullScreenChange,
  className,
}: SiteViewProps) {
  const t = useOpenGeniText();
  const labels = useArtifactLabels();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<unknown>(null);
  const readAbort = useRef<AbortController | null>(null);
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const load = useCallback(async () => {
    readAbort.current?.abort();
    const abort = new AbortController();
    readAbort.current = abort;
    try {
      setError(null);
      const next = await loadSiteSnapshot(client, workspaceId, siteId, {
        signal: abort.signal,
        includeArchivedContent: true,
      });
      if (abort.signal.aborted) return;
      setSnapshot(next);
      onTitleRef.current?.(next.detail.artifact.title);
    } catch (nextError) {
      if (abort.signal.aborted) return;
      setSnapshot(null);
      setError(nextError);
    }
  }, [client, siteId, workspaceId]);
  useEffect(() => {
    setSnapshot(null);
    void load();
    return () => readAbort.current?.abort();
  }, [load]);
  const content = snapshot?.content;
  const bridge = useMemo(
    () =>
      content
        ? toolBridge?.({
            artifactId: siteId,
            siteVersionId: content.versionId,
            requestedTools: content.requestedTools,
          })
        : undefined,
    [content, siteId, toolBridge],
  );
  if (error)
    return (
      <ArtifactProblem
        view={artifactLoadErrorView(t, error, "site", labels)}
        onRetry={() => void load()}
      />
    );
  if (!snapshot || !content) return <ArtifactLoading label={loadingLabel ?? labels.loadingSite} />;
  if (snapshot.detail.artifact.status === "archived")
    return (
      <div className="p-4 text-sm text-fg-muted">{archivedMessage ?? labels.siteArchived}</div>
    );
  return (
    <ArtifactSandbox
      html={content.html}
      title={snapshot.detail.artifact.title}
      showTitle={showTitle}
      versionLabel={
        snapshot.detail.artifact.currentVersion
          ? t("artifacts.siteView.vRevision", {
              revision: snapshot.detail.artifact.currentVersion.revision,
            })
          : undefined
      }
      toolBridge={bridge}
      viewer={viewer}
      connectedToolCount={content.requestedTools.length}
      theme={theme}
      {...(showToolbar !== undefined ? { showToolbar } : {})}
      {...(reloadToken !== undefined ? { reloadToken } : {})}
      {...(fullScreen !== undefined ? { fullScreen } : {})}
      {...(onFullScreenChange ? { onFullScreenChange } : {})}
      fill
      className={className ?? "h-full rounded-none border-0"}
    />
  );
}
