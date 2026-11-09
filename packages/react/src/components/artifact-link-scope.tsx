import {
  resolveOpenGeniLinkTarget,
  type OpenGeniClient,
  type OpenGeniLinkTarget,
} from "@opengeni/sdk";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { OpenGeniLinkResolver } from "./open-geni-links";

export type ArtifactLinkScope = {
  client: Partial<Pick<OpenGeniClient, "resolveArtifactLink">>;
  workspaceId: string;
  sessionId?: string | undefined;
  /** Explicit host destinations retain precedence over automatic metadata reads. */
  override?: OpenGeniLinkResolver | null | undefined;
};

export const ArtifactLinkScopeContext = createContext<ArtifactLinkScope | null>(null);

/** Resolve only workspace-less UUID references; keep every existing typed route synchronous. */
export function useArtifactLinkTarget(target: OpenGeniLinkTarget | null) {
  const scope = useContext(ArtifactLinkScopeContext);
  const fileId =
    target?.kind === "file" && target.workspaceId === null && !scope?.override?.(target)
      ? target.fileId
      : null;
  const client = scope?.client;
  const workspaceId = scope?.workspaceId;
  const sessionId = scope?.sessionId;
  const lookup = useMemo(
    () =>
      typeof client?.resolveArtifactLink === "function" && workspaceId && fileId
        ? (signal?: AbortSignal) =>
            resolveOpenGeniLinkTarget(
              client as Pick<OpenGeniClient, "resolveArtifactLink">,
              { kind: "file", fileId, workspaceId: null },
              workspaceId,
              { sessionId, signal },
            )
        : null,
    [client, workspaceId, sessionId, fileId],
  );
  const [result, setResult] = useState<{
    lookup: typeof lookup;
    target: OpenGeniLinkTarget | null;
    error: unknown;
  } | null>(null);
  useEffect(() => {
    if (!lookup) return;
    const abort = new AbortController();
    void lookup(abort.signal).then(
      (resolved) => {
        if (!abort.signal.aborted) setResult({ lookup, target: resolved, error: null });
      },
      (error: unknown) => {
        if (!abort.signal.aborted) setResult({ lookup, target: null, error });
      },
    );
    return () => abort.abort();
  }, [lookup]);
  const retry = useCallback(async () => {
    if (!lookup) return;
    const resolved = await lookup();
    setResult({ lookup, target: resolved, error: null });
  }, [lookup]);
  if (!lookup) return { target, pending: false, error: null, retry };
  if (result?.lookup !== lookup) return { target: null, pending: true, error: null, retry };
  return { target: result.target, pending: false, error: result.error, retry };
}
