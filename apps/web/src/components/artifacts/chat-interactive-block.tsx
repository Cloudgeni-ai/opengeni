import { inlineHtmlDocument } from "@opengeni/react/artifacts";
import { useAppearance } from "@/lib/appearance";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useEffect, useMemo, useState } from "react";
import { loadSiteSnapshot } from "@opengeni/react/sites";
import { useAppContext } from "@/context";
import { createSiteToolBridge } from "@/lib/site-tool-bridge";
import { ArtifactSandbox } from "./artifact-sandbox";

export type ChatInteractiveBlockProps = {
  workspaceId: string;
  kind: "html" | "site";
  content: string;
};

export function ChatInteractiveBlock(props: ChatInteractiveBlockProps) {
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
        workspaceId={props.workspaceId}
        siteId={value.siteId}
        initialVersionId={value.versionId}
      />
    );
  } catch {
    return <p role="alert">This Site reference is invalid.</p>;
  }
}

function InlineHtml({ workspaceId, content }: ChatInteractiveBlockProps) {
  const { resolvedTheme } = useAppearance();
  const html = useMemo(() => inlineHtmlDocument(content), [content]);
  const { client } = useAppContext();
  const toolBridge = useMemo(
    () =>
      createSiteToolBridge({
        workspaceTools: client.tools.forWorkspace(workspaceId),
        workspaceId,
      }),
    [client, workspaceId],
  );
  return (
    <ArtifactSandbox
      title="Preview"
      showTitle={false}
      showLiveStatus={false}
      html={html}
      toolBridge={toolBridge}
      height={360}
      autoHeight
      theme={resolvedTheme}
    />
  );
}

function SiteEmbed({
  workspaceId,
  siteId,
  initialVersionId,
}: {
  workspaceId: string;
  siteId: string;
  initialVersionId?: string;
}) {
  const [versionId, setVersionId] = useState(initialVersionId);
  return (
    <SiteEmbedContent
      key={versionId ?? "current"}
      workspaceId={workspaceId}
      siteId={siteId}
      versionId={versionId}
      onVersionChange={setVersionId}
    />
  );
}

function SiteEmbedContent({
  workspaceId,
  siteId,
  versionId,
  onVersionChange,
}: {
  workspaceId: string;
  siteId: string;
  versionId?: string | undefined;
  onVersionChange: (id: string) => void;
}) {
  const { client } = useAppContext();
  const [loaded, setLoaded] = useState<{
    client: typeof client;
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
  const toolBridge = useMemo(
    () =>
      content
        ? createSiteToolBridge({
            workspaceTools: client.tools.forWorkspace(workspaceId),
            workspaceId,
            artifactId: siteId,
            siteVersionId: content.versionId,
            requestedTools: content.requestedTools,
          })
        : undefined,
    [client, workspaceId, siteId, content],
  );
  if (error)
    return (
      <p role="alert">
        Couldn’t load this Site.{" "}
        <Button type="button" variant="ghost" size="sm" onClick={() => setRetry((v) => v + 1)}>
          Retry
        </Button>
      </p>
    );
  if (!snapshot) return <p role="status">Loading Site…</p>;
  if (!content) return <p>This Site is archived or unpublished.</p>;
  return (
    <ArtifactSandbox
      title={snapshot.detail.artifact.title}
      html={content.html}
      toolBridge={toolBridge}
      height={400}
      headerControls={
        <>
          <Select
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
          </Select>
          <a className="text-xs underline" href={`/workspaces/${workspaceId}/artifacts/${siteId}`}>
            Open Site
          </a>
        </>
      }
    />
  );
}
