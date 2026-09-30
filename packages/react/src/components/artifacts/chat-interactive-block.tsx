import type { OpenGeniClient, ToolGatewayIdentity } from "@opengeni/sdk";
import { useEffect, useMemo, useState } from "react";

import { loadSiteSnapshot } from "../../sites-ui";
import { useOpenGeniLinkResolver } from "../open-geni-links";
import { ArtifactButton, ArtifactSelect } from "./artifact-chrome";
import { ArtifactSandbox } from "./artifact-sandbox";
import { DeferredChatMedia } from "./deferred-chat-media";
import { inlineHtmlDocument } from "./inline-html-document";
import type { PublishedHtmlArtifactToolBridge } from "./published-html-artifact-frame";

// Fixed chat viewports keep async Site loads and fragment resize messages from
// moving the conversation. Full-screen remains available for larger content.
const INLINE_PREVIEW_HEIGHT = 360;
const SITE_PREVIEW_HEIGHT = 400;
const PREVIEW_CHROME_HEIGHT = 50;

/** Reads a Site needs to render; the console client, the SDK client, or a proxy. */
export type SiteSnapshotClient = Pick<
  OpenGeniClient,
  "getWorkspaceArtifact" | "getWorkspaceArtifactHtml"
> &
  Partial<Pick<OpenGeniClient, "getWorkspaceArtifactContent">>;

/** The exact saved Site a tool bridge is pinned to (absent for inline HTML). */
export type SiteToolScope = {
  artifactId: string;
  siteVersionId: string;
  requestedTools: readonly ToolGatewayIdentity[];
};

/** Host-owned Site API access. Omit it and Sites render without workspace tools. */
export type SiteToolBridgeFactory = (
  site?: SiteToolScope,
) => PublishedHtmlArtifactToolBridge | undefined;

export type ChatInteractiveBlockProps = {
  workspaceId: string;
  kind: "html" | "site";
  content: string;
  client: SiteSnapshotClient;
  toolBridge?: SiteToolBridgeFactory | undefined;
  theme?: "light" | "dark" | undefined;
};

/**
 * Inline preview for an assistant `opengeni-html` or `opengeni-site` fence, as
 * the OpenGeni console renders it. "Open Site" goes through the nearest
 * `resolveLink`, so a host decides where a Site opens.
 */
export function ChatInteractiveBlock(props: ChatInteractiveBlockProps) {
  const height =
    (props.kind === "html" ? INLINE_PREVIEW_HEIGHT : SITE_PREVIEW_HEIGHT) + PREVIEW_CHROME_HEIGHT;
  return (
    <DeferredChatMedia
      key={`${props.workspaceId}:${props.kind}:${props.kind === "site" ? props.content : "inline"}`}
      height={height}
      label={props.kind === "html" ? "preview" : "Site preview"}
    >
      <div style={{ height }}>
        <LoadedChatInteractiveBlock {...props} />
      </div>
    </DeferredChatMedia>
  );
}

function LoadedChatInteractiveBlock(props: ChatInteractiveBlockProps) {
  if (props.kind === "html") return <InlineHtml {...props} />;
  try {
    const value = JSON.parse(props.content);
    if (
      !value ||
      typeof value.siteId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(value.siteId) ||
      (value.versionId !== undefined &&
        (typeof value.versionId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.versionId)))
    )
      throw new Error("Invalid Site reference");
    return (
      <SiteEmbed
        key={`${props.workspaceId}:${value.siteId}:${value.versionId ?? "current"}`}
        {...props}
        siteId={value.siteId}
        initialVersionId={value.versionId}
      />
    );
  } catch {
    return <p role="alert">This Site reference is invalid.</p>;
  }
}

function InlineHtml({ content, toolBridge, theme }: ChatInteractiveBlockProps) {
  const html = useMemo(() => inlineHtmlDocument(content), [content]);
  const bridge = useMemo(() => toolBridge?.(), [toolBridge]);
  return (
    <ArtifactSandbox
      title="Preview"
      showTitle={false}
      showLiveStatus={false}
      html={html}
      toolBridge={bridge}
      height={INLINE_PREVIEW_HEIGHT}
      className="h-full"
      fill
      theme={theme}
    />
  );
}

function SiteEmbed(
  props: ChatInteractiveBlockProps & { siteId: string; initialVersionId?: string },
) {
  const [versionId, setVersionId] = useState(props.initialVersionId);
  return (
    <SiteEmbedContent
      key={versionId ?? "current"}
      {...props}
      versionId={versionId}
      onVersionChange={setVersionId}
    />
  );
}

function SiteEmbedContent({
  workspaceId,
  client,
  toolBridge,
  theme,
  siteId,
  versionId,
  onVersionChange,
}: ChatInteractiveBlockProps & {
  siteId: string;
  versionId?: string | undefined;
  onVersionChange: (id: string) => void;
}) {
  const [loaded, setLoaded] = useState<{
    client: SiteSnapshotClient;
    snapshot: Awaited<ReturnType<typeof loadSiteSnapshot>>;
  } | null>(null);
  const snapshot = loaded?.client === client ? loaded.snapshot : null;
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setError(false);
    setLoaded(null);
    void loadSiteSnapshot(client, workspaceId, siteId, {
      signal: abort.signal,
      ...(versionId ? { versionId } : {}),
    })
      .then((value) => {
        if (!abort.signal.aborted) setLoaded({ client, snapshot: value });
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => abort.abort();
  }, [client, workspaceId, siteId, versionId, retry]);
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
    [toolBridge, siteId, content],
  );
  const open = useOpenGeniLinkResolver()?.({ kind: "site", artifactId: siteId, workspaceId });
  if (error)
    return (
      <p role="alert">
        Couldn’t load this Site.{" "}
        <ArtifactButton size="sm" onClick={() => setRetry((v) => v + 1)}>
          Retry
        </ArtifactButton>
      </p>
    );
  if (!snapshot) return <p role="status">Loading Site…</p>;
  if (!content) return <p>This Site is archived or unpublished.</p>;
  return (
    <ArtifactSandbox
      title={snapshot.detail.artifact.title}
      html={content.html}
      toolBridge={bridge}
      height={SITE_PREVIEW_HEIGHT}
      className="h-full"
      fill
      theme={theme}
      headerControls={
        <>
          {/* One published version has nothing to choose; keep the bar for the title. */}
          {snapshot.detail.versions.length > 1 ||
          !snapshot.detail.versions.some((v) => v.id === content.versionId) ? (
            <ArtifactSelect
              aria-label="Site version"
              className="bg-transparent text-xs"
              value={content.versionId}
              onChange={(e) => onVersionChange(e.target.value)}
            >
              {!snapshot.detail.versions.some((v) => v.id === content.versionId) && (
                <option value={content.versionId}>Saved version</option>
              )}
              {snapshot.detail.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  Version {v.revision}
                </option>
              ))}
            </ArtifactSelect>
          ) : null}
          {open?.href ? (
            <a
              className="shrink-0 whitespace-nowrap text-xs underline"
              href={open.href}
              data-og-open-site=""
            >
              Open Site
            </a>
          ) : open?.open ? (
            <button
              type="button"
              className="shrink-0 cursor-pointer whitespace-nowrap text-xs underline"
              data-og-open-site=""
              onClick={() =>
                void Promise.resolve()
                  .then(open.open)
                  .catch(() => undefined)
              }
            >
              Open Site
            </button>
          ) : null}
        </>
      }
    />
  );
}
