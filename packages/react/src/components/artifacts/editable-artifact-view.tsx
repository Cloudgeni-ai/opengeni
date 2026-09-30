import type { EditableArtifactResource } from "@opengeni/sdk/artifacts";
import {
  createBrowserEditableArtifactSession,
  type CreateBrowserEditableArtifactSessionOptions,
  type EditableArtifactBrowserRuntime,
  type EditableArtifactCacheAuthority,
  type EditableArtifactModality,
} from "@opengeni/sdk/editable-artifacts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ArtifactLoading,
  ArtifactProblem,
  artifactLoadErrorView,
  useArtifactLabels,
  type ArtifactLoadErrorView,
} from "./artifact-chrome";
import { EditableArtifactWorkbenchHost } from "./editable-artifact-workbench";

/**
 * The browser kernels an editor needs, one per modality, plus the host-built
 * Worker URL (for Vite: `@opengeni/sdk/editable-artifacts/worker?worker&url`).
 * Kernels come from `@opengeni/artifact-kernel-wasm-{document,spreadsheet,presentation}`.
 */
export type EditableArtifactRuntimes = Readonly<{
  document: Omit<EditableArtifactBrowserRuntime, "workerUrl" | "workerFactory">;
  spreadsheet: Omit<EditableArtifactBrowserRuntime, "workerUrl" | "workerFactory">;
  presentation: Omit<EditableArtifactBrowserRuntime, "workerUrl" | "workerFactory">;
  workerUrl: string;
  applicationOrigin?: string | undefined;
  /** Loopback development only. */
  allowInsecureDevelopmentAssets?: boolean | undefined;
}>;

/** Everything needed to open one artifact for the current principal. */
export type OpenedEditableArtifact = Readonly<{
  artifact: EditableArtifactResource;
  authority: EditableArtifactCacheAuthority;
  replicaId: string;
}>;

export type EditableArtifactViewProps = Readonly<{
  /** Absolute API (or session proxy) base the live transport talks to. */
  baseUrl: URL;
  workspaceId: string;
  artifactId: string;
  /** Resolve metadata, cache authority, and replica; called again on retry. */
  open: (signal: AbortSignal) => Promise<OpenedEditableArtifact>;
  runtimes: EditableArtifactRuntimes;
  transport?: CreateBrowserEditableArtifactSessionOptions["transport"];
  /** Show the editor's own title header (hosts with their own header hide it). */
  showHeader?: boolean | undefined;
  /** Re-open when this changes (for example the host's credential version). */
  authorityKey?: string | undefined;
  describeError?: ((error: unknown) => ArtifactLoadErrorView) | undefined;
  onTitle?: ((title: string) => void) | undefined;
  /** Loading copy; defaults to the `opening` label. */
  loadingLabel?: string | undefined;
}>;

type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; value: OpenedEditableArtifact }>
  | Readonly<{ kind: "error"; error: unknown }>;

/**
 * One editable document, spreadsheet, or presentation with its first-party
 * editor. The console dock/page and embedding hosts supply only data access.
 */
export function EditableArtifactView({
  baseUrl,
  workspaceId,
  artifactId,
  open,
  runtimes,
  transport,
  showHeader = true,
  authorityKey,
  describeError,
  onTitle,
  loadingLabel,
}: EditableArtifactViewProps) {
  const labels = useArtifactLabels();
  const [loadEpoch, setLoadEpoch] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const openRef = useRef(open);
  openRef.current = open;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  useEffect(() => {
    const abort = new AbortController();
    setState({ kind: "loading" });
    void openRef
      .current(abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return;
        setState({ kind: "ready", value });
        onTitleRef.current?.(value.artifact.title);
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setState({ kind: "error", error });
      });
    return () => abort.abort();
  }, [artifactId, authorityKey, baseUrl.href, loadEpoch, workspaceId]);

  const ready = state.kind === "ready" ? state.value : null;
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const sessionKey = useMemo(
    () =>
      ready
        ? JSON.stringify({
            baseUrl: baseUrl.href,
            workspaceId,
            artifact: { id: ready.artifact.id, modality: ready.artifact.modality },
            authority: ready.authority,
            replicaId: ready.replicaId,
            workerUrl: runtimes.workerUrl,
          })
        : "",
    [baseUrl.href, ready, runtimes.workerUrl, workspaceId],
  );
  const createSession = useCallback(() => {
    if (!ready) throw new Error("Artifact is not open");
    return createBrowserEditableArtifactSession({
      baseUrl,
      workspaceId,
      artifact: ready.artifact,
      storageAuthority: ready.authority,
      replicaId: ready.replicaId,
      runtime: {
        ...runtimeFor(runtimes, ready.artifact.modality),
        workerUrl: runtimes.workerUrl,
        ...(runtimes.applicationOrigin ? { applicationOrigin: runtimes.applicationOrigin } : {}),
        ...(runtimes.allowInsecureDevelopmentAssets
          ? { allowInsecureDevelopmentAssets: true }
          : {}),
      },
      ...(transportRef.current ? { transport: transportRef.current } : {}),
    });
  }, [baseUrl, ready, runtimes, workspaceId]);

  if (state.kind === "loading") return <ArtifactLoading label={loadingLabel ?? labels.opening} />;
  if (state.kind === "error") {
    return (
      <ArtifactProblem
        view={
          describeError
            ? describeError(state.error)
            : artifactLoadErrorView(state.error, "editable", labels)
        }
        onRetry={() => setLoadEpoch((value) => value + 1)}
      />
    );
  }
  const { artifact } = state.value;
  const surface = { title: artifact.title, showHeader };
  return (
    <div className="h-full min-h-0 bg-og-bg text-og-fg">
      <EditableArtifactWorkbenchHost
        sessionKey={sessionKey}
        createSession={createSession}
        document={surface}
        spreadsheet={surface}
        presentation={surface}
      />
    </div>
  );
}

function runtimeFor(
  runtimes: EditableArtifactRuntimes,
  modality: EditableArtifactModality,
): Omit<EditableArtifactBrowserRuntime, "workerUrl" | "workerFactory"> {
  switch (modality) {
    case "document":
      return runtimes.document;
    case "spreadsheet":
      return runtimes.spreadsheet;
    case "presentation":
      return runtimes.presentation;
  }
}
