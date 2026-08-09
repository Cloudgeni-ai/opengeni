import {
  createBrowserEditableArtifactSession,
  type CreateBrowserEditableArtifactSessionOptions,
  type EditableArtifactBrowserRuntime,
  type EditableArtifactSession,
} from "@opengeni/sdk/editable-artifacts";
import { useCallback, useEffect, useRef, useState } from "react";

import { EditableArtifactMessage } from "./editable-artifact-ui";
import {
  EditableDocumentArtifactSurface,
  type EditableDocumentArtifactSurfaceProps,
} from "./editable-document";
import {
  EditablePresentationArtifactSurface,
  type EditablePresentationArtifactSurfaceProps,
} from "./editable-presentation";
import {
  EditableSpreadsheetArtifactSurface,
  type EditableSpreadsheetArtifactSurfaceProps,
} from "./editable-spreadsheet";

export type EditableArtifactWorkbenchProps = Readonly<{
  session: EditableArtifactSession;
  document?: Omit<EditableDocumentArtifactSurfaceProps, "session">;
  spreadsheet?: Omit<EditableSpreadsheetArtifactSurfaceProps, "session">;
  presentation?: Omit<EditablePresentationArtifactSurfaceProps, "session">;
}>;

export type EditableArtifactWorkbenchHostProps = Omit<EditableArtifactWorkbenchProps, "session"> &
  Readonly<{
    /**
     * Complete identity of the browser session authority. Change this when the
     * artifact, deployment, principal, or authorization epoch changes.
     */
    sessionKey: string;
    /** Called for the active keyed lifecycle and again only after replacement or retry. */
    createSession: () => EditableArtifactSession;
  }>;

type DefaultBrowserArtifactTransport = Omit<
  NonNullable<CreateBrowserEditableArtifactSessionOptions["transport"]>,
  "apiKey" | "fetch" | "headers" | "webSocketFactory"
> &
  Readonly<{
    /** Static deployment auth headers; rotate authorizationEpoch when they change. */
    headers?: Readonly<Record<string, string>>;
  }>;

export type BrowserEditableArtifactWorkbenchOptions = Omit<
  CreateBrowserEditableArtifactSessionOptions,
  "runtime" | "storage" | "transport"
> &
  Readonly<{
    /** Default module Worker only; custom Worker hosts use EditableArtifactWorkbenchHost. */
    runtime: Omit<EditableArtifactBrowserRuntime, "workerFactory">;
    /** Default fetch/WebSocket only; static deployment auth headers are supported. */
    transport?: DefaultBrowserArtifactTransport;
  }>;

export type BrowserEditableArtifactWorkbenchProps = Omit<
  EditableArtifactWorkbenchProps,
  "session"
> &
  Readonly<{ options: BrowserEditableArtifactWorkbenchOptions }>;

/**
 * One modality-neutral SDK workbench. Embedding hosts keep one route/component;
 * each artifact still renders through its complete first-party editor surface.
 */
export function EditableArtifactWorkbench({
  session,
  document,
  spreadsheet,
  presentation,
}: EditableArtifactWorkbenchProps) {
  switch (session.modality) {
    case "document":
      return (
        <EditableDocumentArtifactSurface
          {...document}
          session={session}
          title={document?.title ?? "Document"}
        />
      );
    case "spreadsheet":
      return <EditableSpreadsheetArtifactSurface {...spreadsheet} session={session} />;
    case "presentation":
      return <EditablePresentationArtifactSurface {...presentation} session={session} />;
  }
}

/**
 * Route/embed composition that owns exactly one SDK session. The host supplies
 * the authenticated SDK factory; React guarantees replacement and teardown.
 */
export function EditableArtifactWorkbenchHost({
  sessionKey,
  createSession,
  document,
  spreadsheet,
  presentation,
}: EditableArtifactWorkbenchHostProps) {
  const createSessionRef = useRef(createSession);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [state, setState] = useState<
    | Readonly<{ key: string; session: EditableArtifactSession; error: null }>
    | Readonly<{ key: string | null; session: null; error: Error | null }>
  >({ key: null, session: null, error: null });

  useEffect(() => {
    createSessionRef.current = createSession;
  }, [createSession]);

  useEffect(() => {
    let owned: EditableArtifactSession | null = null;
    setState({ key: sessionKey, session: null, error: null });
    try {
      owned = createSessionRef.current();
      setState({ key: sessionKey, session: owned, error: null });
    } catch (cause) {
      setState({
        key: sessionKey,
        session: null,
        error: cause instanceof Error ? cause : new Error("Could not create artifact session"),
      });
    }
    return () => {
      const closing = owned;
      owned = null;
      if (closing) void closing.close().catch(() => undefined);
    };
  }, [retryEpoch, sessionKey]);

  const retry = useCallback(() => setRetryEpoch((value) => value + 1), []);
  const currentError = state.key === sessionKey ? state.error : null;
  if (state.key === sessionKey && state.session) {
    return (
      <EditableArtifactWorkbench
        session={state.session}
        {...(document ? { document } : {})}
        {...(spreadsheet ? { spreadsheet } : {})}
        {...(presentation ? { presentation } : {})}
      />
    );
  }
  return (
    <EditableArtifactMessage
      title={currentError ? "Could not open this artifact" : "Opening artifact"}
      detail={currentError?.message ?? "Starting the secure editing session…"}
      retry={currentError ? retry : undefined}
    />
  );
}

/**
 * Complete default-browser composition for embedders: verified WASM Worker,
 * durable IndexedDB state, authenticated live sync, teardown, and the matching
 * first-party editor. Advanced/custom transports compose the lower-level host.
 */
export function BrowserEditableArtifactWorkbench({
  options,
  document,
  spreadsheet,
  presentation,
}: BrowserEditableArtifactWorkbenchProps) {
  const sessionKey = browserSessionKey(options);
  const createSession = useCallback(() => createBrowserEditableArtifactSession(options), [options]);
  return (
    <EditableArtifactWorkbenchHost
      sessionKey={sessionKey}
      createSession={createSession}
      {...(document ? { document } : {})}
      {...(spreadsheet ? { spreadsheet } : {})}
      {...(presentation ? { presentation } : {})}
    />
  );
}

function browserSessionKey(options: BrowserEditableArtifactWorkbenchOptions): string {
  const transport = options.transport
    ? {
        ...options.transport,
        // Credentials must not be copied into React lifecycle keys. The
        // authorization epoch is the explicit credential/grant rotation fence.
        headers: options.transport.headers
          ? Object.keys(options.transport.headers).sort()
          : undefined,
      }
    : null;
  return JSON.stringify(
    {
      baseUrl: options.baseUrl,
      workspaceId: options.workspaceId,
      artifact: { id: options.artifact.id, modality: options.artifact.modality },
      storageAuthority: options.storageAuthority,
      runtime: options.runtime,
      replicaId: options.replicaId ?? null,
      transport,
    },
    (_key, value: unknown) => (value instanceof URL ? value.href : value),
  );
}
