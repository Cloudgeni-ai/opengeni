import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SiteViewer } from "@opengeni/sdk";

import { loadSiteSnapshot } from "../../sites-ui";
import {
  ArtifactLoading,
  ArtifactProblem,
  artifactLoadErrorView,
  useArtifactLabels,
} from "./artifact-chrome";
import { ArtifactSandbox } from "./artifact-sandbox";
import type { SiteLiveStatus } from "./artifact-sandbox";
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
  /**
   * Replaces the toolbar's "Live" indicator, for example with a link to the
   * published Site; `null` shows nothing there. Omit it for the default.
   */
  liveStatus?: ReactNode | undefined;
  /** Reload the Site whenever this changes. */
  reloadToken?: number | undefined;
  /**
   * The Site's current version as the host last read it, for a host that
   * watches the Site for new versions. When it differs from the version
   * shown, the view loads it and the Site reloads in place; the version on
   * screen stays until the new one has loaded.
   */
  versionId?: string | null | undefined;
  /**
   * Whether the host's watch for new versions is working: `live` (the
   * default once `versionId` is given) or `reconnecting`. With it, the frame's
   * Live label tells the truth: Live, Updating while a new version loads, or
   * Reconnecting. Without `versionId` or this, the label stays as before.
   */
  watch?: "live" | "reconnecting" | undefined;
  /** Drawn instead of the version badge, for example a version history menu. */
  versionControl?: ReactNode | undefined;
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
  liveStatus,
  reloadToken,
  versionId,
  watch,
  versionControl,
  fullScreen,
  onFullScreenChange,
  className,
}: SiteViewProps) {
  const t = useOpenGeniText();
  const labels = useArtifactLabels();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<unknown>(null);
  // A newer version is loading (or failed to) behind the one on screen.
  const [refresh, setRefresh] = useState<"idle" | "loading" | "failed">("idle");
  const readAbort = useRef<AbortController | null>(null);
  // Failed background loads in a row, for the wait before the next try.
  const [failures, setFailures] = useState(0);
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const load = useCallback(
    async (background = false) => {
      readAbort.current?.abort();
      const abort = new AbortController();
      readAbort.current = abort;
      try {
        if (background) setRefresh("loading");
        else setError(null);
        const next = await loadSiteSnapshot(client, workspaceId, siteId, {
          signal: abort.signal,
          includeArchivedContent: true,
        });
        if (abort.signal.aborted) return;
        setSnapshot(next);
        setError(null);
        setRefresh("idle");
        setFailures(0);
        onTitleRef.current?.(next.detail.artifact.title);
      } catch (nextError) {
        if (abort.signal.aborted) return;
        // A failed update keeps the version on screen; the label says so.
        if (background) {
          setRefresh("failed");
          setFailures((count) => count + 1);
        } else {
          setSnapshot(null);
          setError(nextError);
        }
      }
    },
    [client, siteId, workspaceId],
  );
  useEffect(() => {
    setSnapshot(null);
    setRefresh("idle");
    void load();
    return () => readAbort.current?.abort();
  }, [load]);
  const content = snapshot?.content;
  const shownVersion = content?.versionId ?? null;
  // Follow the host's current version once something is on screen. Only a
  // change of `versionId` asks again, so a host that read an older version
  // than the one shown never makes the view load in a loop.
  const loaded = snapshot !== null;
  const shownRef = useRef(shownVersion);
  shownRef.current = shownVersion;
  useEffect(() => {
    if (!loaded || !versionId || versionId === shownRef.current) return;
    void load(true);
  }, [load, loaded, versionId]);
  // A failed update tries again, waiting longer each time (up to 30 s), until
  // the version on screen is the host's or the host moves on to another. A
  // hidden tab waits and tries once it is shown again.
  useEffect(() => {
    if (refresh !== "failed" || !versionId || versionId === shownRef.current) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      const onVisible = () => {
        if (document.visibilityState === "visible") void load(true);
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => document.removeEventListener("visibilitychange", onVisible);
    }
    const delay = Math.min(30_000, 2_000 * 2 ** Math.max(0, failures - 1));
    const timer = setTimeout(() => void load(true), delay);
    return () => clearTimeout(timer);
  }, [failures, load, refresh, versionId]);
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
  const liveState: SiteLiveStatus | undefined =
    versionId === undefined && watch === undefined
      ? undefined
      : refresh === "loading" || (versionId && versionId !== shownVersion && refresh !== "failed")
        ? "updating"
        : watch === "reconnecting" || refresh === "failed"
          ? "reconnecting"
          : "live";
  return (
    <ArtifactSandbox
      html={content.html}
      title={snapshot.detail.artifact.title}
      showTitle={showTitle}
      versionLabel={
        !versionControl && snapshot.detail.artifact.currentVersion
          ? t("artifacts.siteView.vRevision", {
              revision: snapshot.detail.artifact.currentVersion.revision,
            })
          : undefined
      }
      headerControls={versionControl}
      liveState={liveState}
      toolBridge={bridge}
      viewer={viewer}
      connectedToolCount={content.requestedTools.length}
      theme={theme}
      {...(showToolbar !== undefined ? { showToolbar } : {})}
      {...(liveStatus !== undefined ? { liveStatus } : {})}
      {...(reloadToken !== undefined ? { reloadToken } : {})}
      // A new version is a new page, even when its HTML is unchanged (its
      // tool bridge is bound to the version); it replaces the frame in the
      // same render as its HTML, so the Site loads once.
      frameKey={content.versionId}
      {...(fullScreen !== undefined ? { fullScreen } : {})}
      {...(onFullScreenChange ? { onFullScreenChange } : {})}
      fill
      className={className ?? "h-full rounded-none border-0"}
    />
  );
}
