import { SESSION_SCOPE_HEADER, type ClientConfig, type OpenGeniClient } from "@opengeni/sdk";
import { createEditableArtifactReplicaId } from "@opengeni/sdk/editable-artifacts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/cn";
import { useOpenGeni, type ClientOverride } from "../../session-context";
import {
  ArtifactLabelsProvider,
  ArtifactLoading,
  ArtifactProblem,
  ArtifactViewerHeader,
  artifactLoadErrorView,
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

const viewerClientKeys = new WeakMap<ViewerClient, string>();

function viewerClientKey(client: ViewerClient): string {
  let key = viewerClientKeys.get(client);
  if (!key) {
    key = crypto.randomUUID();
    viewerClientKeys.set(client, key);
  }
  return key;
}

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
    client: ViewerClient;
    workspaceId: string;
    title: string;
    kind: ArtifactKind | null;
  } | null>(null);
  const targetKey = `${target.kind}:${target.artifactId}`;
  const current =
    loaded?.key === targetKey && loaded.client === client && loaded.workspaceId === workspaceId
      ? loaded
      : null;
  const kind: ArtifactKind | null = target.kind === "site" ? "site" : (current?.kind ?? null);
  const [unavailable, setUnavailable] = useState<{
    key: string;
    client: ViewerClient;
    workspaceId: string;
  } | null>(null);
  const markUnavailable = useCallback(
    () => setUnavailable({ key: targetKey, client, workspaceId }),
    [client, targetKey, workspaceId],
  );
  const title =
    current?.title ??
    target.title ??
    (unavailable?.key === targetKey &&
    unavailable.client === client &&
    unavailable.workspaceId === workspaceId
      ? labels.artifact
      : labels.opening);
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
            onTitle={(next) =>
              setLoaded({ key: targetKey, client, workspaceId, title: next, kind: "site" })
            }
          />
        ) : (
          <EditableBody
            key={targetKey}
            client={client}
            workspaceId={workspaceId}
            sessionId={sessionId}
            artifactId={target.artifactId}
            runtimes={editableRuntimes}
            onOpened={(next, modality) =>
              setLoaded({ key: targetKey, client, workspaceId, title: next, kind: modality })
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
  sessionId,
  artifactId,
  runtimes,
  onOpened,
  onUnavailable,
}: {
  client: ViewerClient;
  workspaceId: string;
  sessionId: string;
  artifactId: string;
  runtimes: EditableArtifactRuntimes | undefined;
  onOpened: (title: string, modality: ArtifactKind) => void;
  onUnavailable: () => void;
}) {
  const labels = useArtifactLabels();
  const clientKey = viewerClientKey(client);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [configState, setConfigState] = useState<{
    client: ViewerClient;
    workspaceId: string;
    sessionId: string;
    result:
      | { kind: "ready"; config: NonNullable<ClientConfig["artifacts"]> }
      | { kind: "unavailable" }
      | { kind: "error"; error: unknown };
  } | null>(null);
  const current =
    configState?.client === client &&
    configState.workspaceId === workspaceId &&
    configState.sessionId === sessionId
      ? configState.result
      : null;
  const config = current?.kind === "ready" ? current.config : null;
  const scopeRef = useRef({ client, workspaceId, sessionId });
  scopeRef.current = { client, workspaceId, sessionId };
  useEffect(() => {
    let live = true;
    setConfigState(null);
    client.getClientConfig().then(
      (value) =>
        live &&
        setConfigState({
          client,
          workspaceId,
          sessionId,
          result: value.artifacts
            ? { kind: "ready", config: value.artifacts }
            : { kind: "unavailable" },
        }),
      (error: unknown) =>
        live &&
        setConfigState({ client, workspaceId, sessionId, result: { kind: "error", error } }),
    );
    return () => {
      live = false;
    };
  }, [client, retryEpoch, sessionId, workspaceId]);
  const baseUrl = useMemo(
    () => new URL(client.apiUrl("/"), globalThis.location?.href ?? "http://localhost/"),
    [client],
  );
  const transport = useMemo(() => {
    if (!config) return undefined;
    const socket = new URL(config.editableLiveUrl);
    let scope = new AbortController();
    const checkCurrent = (signal: AbortSignal) => {
      signal.throwIfAborted();
      if (
        scopeRef.current.client !== client ||
        scopeRef.current.workspaceId !== workspaceId ||
        scopeRef.current.sessionId !== sessionId
      ) {
        throw new DOMException("Artifact viewer scope changed", "AbortError");
      }
    };
    return {
      activate: () => {
        if (scope.signal.aborted) scope = new AbortController();
      },
      abort: () => scope.abort(),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const signal = AbortSignal.any([scope.signal, ...(init?.signal ? [init.signal] : [])]);
        checkCurrent(signal);
        const url = new URL(input instanceof Request ? input.url : input, baseUrl);
        if (
          init?.method === "POST" &&
          url.pathname ===
            new URL(
              `v1/workspaces/${encodeURIComponent(workspaceId)}/editable-artifacts/${encodeURIComponent(artifactId)}/live-ticket`,
              baseUrl,
            ).pathname
        ) {
          // A reconnect must revalidate the current host principal before
          // minting a ticket for the editor's retained cache partition.
          const next = (await client.getClientConfig({ signal })).artifacts;
          checkCurrent(signal);
          if (!next || artifactCapabilityKey(next) !== artifactCapabilityKey(config)) {
            setConfigState({
              client,
              workspaceId,
              sessionId,
              result: next ? { kind: "ready", config: next } : { kind: "unavailable" },
            });
            scope.abort();
            signal.throwIfAborted();
          }
          const { replicaId } = (await new Request(input, init).json()) as {
            replicaId?: unknown;
          };
          if (typeof replicaId !== "string") throw new TypeError("Artifact replica is required");
          await client.getEditableArtifact(workspaceId, artifactId, { replicaId, signal });
          checkCurrent(signal);
        }
        return client.fetchApi(url, { ...init, signal });
      }) as typeof fetch,
      webSocketUrl: socket,
      ...(isLoopback(baseUrl) && isLoopback(socket)
        ? { allowInsecureDevelopmentTransport: true }
        : {}),
    };
  }, [artifactId, baseUrl, client, config, sessionId, workspaceId]);
  useEffect(() => {
    transport?.activate();
    return () => transport?.abort();
  }, [transport]);
  const blocked = current !== null && (current.kind !== "ready" || !runtimes);
  useEffect(() => {
    if (blocked) onUnavailable();
  }, [blocked, onUnavailable]);
  if (!current) return <ArtifactLoading label={labels.opening} />;
  if (current.kind === "error") {
    return (
      <ArtifactProblem
        view={artifactLoadErrorView(current.error, "editable", labels)}
        onRetry={() => setRetryEpoch((value) => value + 1)}
      />
    );
  }
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
      authorityKey={JSON.stringify([clientKey, sessionId, artifactCapabilityKey(config)])}
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
        signal.throwIfAborted();
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

function artifactCapabilityKey(config: NonNullable<ClientConfig["artifacts"]>): string {
  return JSON.stringify([
    config.editableLiveUrl,
    config.cachePartition.accountId,
    config.cachePartition.principalId,
    config.cachePartition.authorizationEpoch,
  ]);
}

function isLoopback(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "ws:") &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  );
}
