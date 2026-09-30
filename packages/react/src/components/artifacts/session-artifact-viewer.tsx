import { SESSION_SCOPE_HEADER, type ClientConfig, type OpenGeniClient } from "@opengeni/sdk";
import { createEditableArtifactReplicaId } from "@opengeni/sdk/editable-artifacts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "../../lib/cn";
import { useOpenGeni, type ClientOverride } from "../../session-context";
import {
  ArtifactLabelsProvider,
  ArtifactProblem,
  ArtifactViewerHeader,
  useArtifactLabels,
  type ArtifactKind,
  type ArtifactLabels,
} from "./artifact-chrome";
import { EditableArtifactView, type EditableArtifactRuntimes } from "./editable-artifact-view";
import type { SiteToolBridgeFactory } from "./chat-interactive-block";
import { SiteView } from "./site-view";

/** An artifact opened from a session: the targets agent links and Site previews name. */
export type SessionArtifactTarget = Readonly<
  | { kind: "editable-artifact"; artifactId: string; title?: string | undefined }
  | { kind: "site"; artifactId: string; title?: string | undefined }
>;

/** Every string the viewer shows, including its Site frame and states. */
export type SessionArtifactViewerLabels = Partial<ArtifactLabels>;

export type SessionArtifactViewerProps = ClientOverride &
  Readonly<{
    /** The conversation the artifact belongs to; the proxy only serves its artifacts. */
    sessionId: string;
    target: SessionArtifactTarget;
    onClose: () => void;
    /** Show a Back control, for example to return to the conversation on phones. */
    onBack?: (() => void) | undefined;
    /** Browser kernels and Worker for documents, spreadsheets, and presentations. */
    editableRuntimes?: EditableArtifactRuntimes | undefined;
    theme?: "light" | "dark" | undefined;
    /** Host-owned Site API access; omit it and Sites render without workspace tools. */
    siteToolBridge?: SiteToolBridgeFactory | undefined;
    labels?: SessionArtifactViewerLabels | undefined;
    className?: string | undefined;
  }>;

type ViewerClient = Pick<
  OpenGeniClient,
  | "withHeaders"
  | "apiUrl"
  | "fetchApi"
  | "getClientConfig"
  | "getEditableArtifact"
  | "getWorkspaceArtifact"
  | "getWorkspaceArtifactHtml"
>;

/**
 * A host-mountable viewer for one editable artifact or Site from a session,
 * with its own header (title, Back, Close). Mount it in any sized container
 * (a side panel, a sheet); it fills it. Data flows through the provider's
 * client and `createSessionProxyHandler({ artifacts: true })`, scoped to
 * `sessionId`.
 */
export function SessionArtifactViewer({ labels, ...props }: SessionArtifactViewerProps) {
  return (
    <ArtifactLabelsProvider labels={labels}>
      <Viewer {...props} />
    </ArtifactLabelsProvider>
  );
}

function Viewer({
  client: clientOverride,
  workspaceId: workspaceOverride,
  sessionId,
  target,
  onClose,
  onBack,
  editableRuntimes,
  theme,
  siteToolBridge,
  className,
}: Omit<SessionArtifactViewerProps, "labels">) {
  const labels = useArtifactLabels();
  const context = useOpenGeni({ client: clientOverride, workspaceId: workspaceOverride });
  const base = context.client as unknown as ViewerClient;
  const workspaceId = context.workspaceId;
  const client = useMemo(
    () => base.withHeaders({ [SESSION_SCOPE_HEADER]: sessionId }),
    [base, sessionId],
  );
  const [loaded, setLoaded] = useState<{
    key: string;
    title: string;
    kind: ArtifactKind | null;
  } | null>(null);
  const targetKey = `${target.kind}:${target.artifactId}`;
  const current = loaded?.key === targetKey ? loaded : null;
  const kind: ArtifactKind | null = target.kind === "site" ? "site" : (current?.kind ?? null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const markUnavailable = useCallback(() => setUnavailable(targetKey), [targetKey]);
  const title =
    current?.title ??
    target.title ??
    (unavailable === targetKey ? labels.artifact : labels.opening);
  return (
    <section
      aria-label={title}
      data-og-artifact-viewer={target.kind}
      className={cn("og-root flex h-full min-h-0 w-full min-w-0 flex-col bg-bg text-fg", className)}
    >
      <ArtifactViewerHeader
        kind={kind}
        title={title}
        onBack={onBack}
        backLabel={labels.back}
        onClose={onClose}
        closeLabel={labels.close}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {target.kind === "site" ? (
          <SiteView
            key={targetKey}
            client={client}
            workspaceId={workspaceId}
            siteId={target.artifactId}
            theme={theme}
            toolBridge={siteToolBridge}
            showTitle={false}
            onTitle={(next) => setLoaded({ key: targetKey, title: next, kind: "site" })}
          />
        ) : (
          <EditableBody
            key={targetKey}
            client={client}
            workspaceId={workspaceId}
            artifactId={target.artifactId}
            runtimes={editableRuntimes}
            onOpened={(next, modality) =>
              setLoaded({ key: targetKey, title: next, kind: modality })
            }
            onUnavailable={markUnavailable}
          />
        )}
      </div>
    </section>
  );
}

function EditableBody({
  client,
  workspaceId,
  artifactId,
  runtimes,
  onOpened,
  onUnavailable,
}: {
  client: ViewerClient;
  workspaceId: string;
  artifactId: string;
  runtimes: EditableArtifactRuntimes | undefined;
  onOpened: (title: string, modality: ArtifactKind) => void;
  onUnavailable: () => void;
}) {
  const labels = useArtifactLabels();
  const [config, setConfig] = useState<ClientConfig["artifacts"] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    client.getClientConfig().then(
      (value) => live && setConfig(value.artifacts ?? null),
      () => live && setConfig(null),
    );
    return () => {
      live = false;
    };
  }, [client]);
  const baseUrl = useMemo(
    () => new URL(client.apiUrl("/"), globalThis.location?.href ?? "http://localhost/"),
    [client],
  );
  const transport = useMemo(() => {
    if (!config) return undefined;
    const socket = new URL(config.editableLiveUrl);
    return {
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        client.fetchApi(input instanceof Request ? input.url : input, init)) as typeof fetch,
      webSocketUrl: socket,
      ...(isLoopback(baseUrl) && isLoopback(socket)
        ? { allowInsecureDevelopmentTransport: true }
        : {}),
    };
  }, [baseUrl, client, config]);
  const blocked = config === null || (config !== undefined && !runtimes);
  useEffect(() => {
    if (blocked) onUnavailable();
  }, [blocked, onUnavailable]);
  if (config === undefined) return null;
  if (!config || !transport) {
    return <ArtifactProblem view={{ ...labels.viewingDisabled, retryable: false }} />;
  }
  if (!runtimes) {
    return <ArtifactProblem view={{ ...labels.editorsMissing, retryable: false }} />;
  }
  return (
    <EditableArtifactView
      baseUrl={baseUrl}
      workspaceId={workspaceId}
      artifactId={artifactId}
      runtimes={{
        ...runtimes,
        ...(isLoopback(baseUrl) ? { allowInsecureDevelopmentAssets: true } : {}),
      }}
      transport={transport}
      showHeader={false}
      open={async (signal) => {
        const replicaId = createEditableArtifactReplicaId();
        const artifact = await client.getEditableArtifact(workspaceId, artifactId, {
          replicaId,
          signal,
        });
        onOpened(artifact.title, artifact.modality);
        return {
          artifact,
          replicaId,
          authority: {
            deploymentOrigin: baseUrl.origin,
            workspaceId,
            ...config.cachePartition,
          },
        };
      }}
    />
  );
}

function isLoopback(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "ws:") &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  );
}
