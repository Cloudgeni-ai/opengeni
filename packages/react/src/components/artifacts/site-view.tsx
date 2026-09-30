import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadSiteSnapshot } from "../../sites-ui";
import { ArtifactLoading, ArtifactProblem, artifactLoadErrorView } from "./artifact-chrome";
import { ArtifactSandbox } from "./artifact-sandbox";
import type { SiteSnapshotClient, SiteToolBridgeFactory } from "./chat-interactive-block";

type Snapshot = Awaited<ReturnType<typeof loadSiteSnapshot>>;

export type SiteViewProps = {
  client: SiteSnapshotClient;
  workspaceId: string;
  siteId: string;
  /** Host-owned Site API access. Omit it and the Site renders without workspace tools. */
  toolBridge?: SiteToolBridgeFactory | undefined;
  theme?: "light" | "dark" | undefined;
  /** Shown instead of the archived notice; the console links to its full page. */
  archivedMessage?: string | undefined;
  /** Show the Site title in the frame bar; hide it under a host header that already does. */
  showTitle?: boolean | undefined;
  /** Loading copy; defaults to "Loading Site…". */
  loadingLabel?: string | undefined;
  /** Called with the loaded title, for a host header. */
  onTitle?: ((title: string) => void) | undefined;
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
  theme,
  archivedMessage = "This Site is archived.",
  showTitle = true,
  loadingLabel = "Loading Site…",
  onTitle,
  className,
}: SiteViewProps) {
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
      <ArtifactProblem view={artifactLoadErrorView(error, "site")} onRetry={() => void load()} />
    );
  if (!snapshot || !content) return <ArtifactLoading label={loadingLabel} />;
  if (snapshot.detail.artifact.status === "archived")
    return <div className="p-4 text-sm text-fg-muted">{archivedMessage}</div>;
  return (
    <ArtifactSandbox
      html={content.html}
      title={snapshot.detail.artifact.title}
      showTitle={showTitle}
      versionLabel={`v${snapshot.detail.artifact.currentVersion?.revision}`}
      toolBridge={bridge}
      connectedToolCount={content.requestedTools.length}
      theme={theme}
      fill
      className={className ?? "h-full rounded-none border-0"}
    />
  );
}
