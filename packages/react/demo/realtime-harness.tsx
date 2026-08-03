import {
  type EffectiveSessionControl,
  OpenGeniClient,
  type SessionRealtimeModel,
} from "@opengeni/sdk";
import {
  ChatComposer,
  HumanInputSurface,
  MessageTimeline,
  OpenGeniProvider,
  SessionStatus,
  useComposer,
  useHumanInputRequests,
  useSession,
  useSessionEvents,
} from "@opengeni/react";
import { NewSessionRealtimeControl, SessionRealtimeControl } from "@opengeni/react/realtime";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { MANAGER_SESSION_ID, MockOpenGeniClient } from "./mock";
import { createDeterministicRealtimeHarness } from "./realtime-controller";
import "./styles.css";

const MOCK_WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "live" ? "live" : "mock";
const initialWorkspaceId = params.get("workspaceId") ?? MOCK_WORKSPACE_ID;
const initialSessionId = params.get("sessionId") ?? (mode === "mock" ? MANAGER_SESSION_ID : "");
const deterministicRealtime = createDeterministicRealtimeHarness();
const client =
  mode === "live"
    ? new OpenGeniClient({
        baseUrl: "/demo-api",
        fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
      })
    : new MockOpenGeniClient();

function ReferenceConsumer() {
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [realtimeAutostartModel, setRealtimeAutostartModel] = useState<SessionRealtimeModel | null>(
    null,
  );
  const [creationCount, setCreationCount] = useState(0);

  if (!workspaceId || (mode === "live" && !sessionId)) {
    return (
      <LiveConfiguration
        workspaceId={workspaceId}
        sessionId={sessionId}
        onSubmit={(nextWorkspaceId, nextSessionId) => {
          setWorkspaceId(nextWorkspaceId);
          setSessionId(nextSessionId);
          writeLiveLocation(nextWorkspaceId, nextSessionId);
        }}
      />
    );
  }

  const createRealtimeFirstSession = async (model: SessionRealtimeModel): Promise<boolean> => {
    const requestedSessionId = crypto.randomUUID();
    const created = await client.createSession(workspaceId, {
      requestedSessionId,
      startMode: "realtime",
      idempotencyKey: `react-realtime-demo:${requestedSessionId}`,
    });
    setCreationCount((value) => value + 1);
    setRealtimeAutostartModel(model);
    setSessionId(created.id);
    writeLiveLocation(workspaceId, created.id);
    return true;
  };

  return (
    <OpenGeniProvider client={client} workspaceId={workspaceId}>
      <main className="og-root min-h-dvh bg-og-bg px-4 py-8 text-og-fg sm:px-6">
        <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <ExistingSession
            key={sessionId}
            sessionId={sessionId}
            autostartModel={realtimeAutostartModel}
            onAutostartConsumed={() => setRealtimeAutostartModel(null)}
          />
          <aside className="space-y-6">
            <section className="rounded-og-xl border border-og-border bg-og-surface-1 p-4 shadow-og-sm">
              <p className="text-og-xs font-medium uppercase tracking-[0.12em] text-og-fg-subtle">
                Public reference consumer
              </p>
              <h1 className="mt-2 text-og-lg font-semibold">@opengeni/react/realtime</h1>
              <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-og-xs">
                <dt className="text-og-fg-subtle">Mode</dt>
                <dd data-testid="demo-mode" className="font-og-mono">
                  {mode}
                </dd>
                <dt className="text-og-fg-subtle">Workspace</dt>
                <dd className="truncate font-og-mono">{workspaceId}</dd>
                <dt className="text-og-fg-subtle">Session</dt>
                <dd data-testid="current-session-id" className="truncate font-og-mono">
                  {sessionId}
                </dd>
                <dt className="text-og-fg-subtle">Created here</dt>
                <dd data-testid="realtime-first-count" className="font-og-mono">
                  {creationCount}
                </dd>
              </dl>
              {mode === "mock" ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => deterministicRealtime.reconnect(sessionId)}
                    className="rounded-og-md border border-og-border px-2.5 py-1.5 text-og-xs hover:border-og-accent/40"
                  >
                    Simulate reconnect
                  </button>
                  <button
                    type="button"
                    onClick={() => deterministicRealtime.fail(sessionId)}
                    className="rounded-og-md border border-og-border px-2.5 py-1.5 text-og-xs hover:border-og-accent/40"
                  >
                    Simulate error
                  </button>
                </div>
              ) : null}
            </section>
            <NewSessionComposer onStart={createRealtimeFirstSession} />
          </aside>
        </div>
      </main>
    </OpenGeniProvider>
  );
}

function ExistingSession(props: {
  sessionId: string;
  autostartModel: SessionRealtimeModel | null;
  onAutostartConsumed(): void;
}) {
  const { session } = useSession(props.sessionId, { pollIntervalMs: mode === "live" ? 5_000 : 0 });
  const events = useSessionEvents(props.sessionId);
  const composer = useComposer(props.sessionId, {
    events: events.events,
    effectiveControl: session?.effectiveControl,
  });
  const humanInput = useHumanInputRequests(props.sessionId, { events: events.events });
  const status = events.sessionStatus ?? session?.status ?? "idle";
  const effectiveControl = session?.effectiveControl ?? ACTIVE_CONTROL;

  return (
    <section
      data-realtime-existing-composer=""
      className="flex min-h-[42rem] flex-col overflow-hidden rounded-og-xl border border-og-border bg-og-surface-1 shadow-og-sm"
    >
      <header className="flex items-center justify-between gap-3 border-b border-og-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-og-sm font-semibold">Existing-session composer</h2>
          <p className="truncate font-og-mono text-[11px] text-og-fg-subtle">{props.sessionId}</p>
        </div>
        <SessionStatus status={status} />
      </header>
      <MessageTimeline items={events.timeline} status={status} className="min-h-0 flex-1" />
      <HumanInputSurface
        requests={humanInput.requests}
        respondingRequestId={humanInput.respondingRequestId}
        error={humanInput.mutationError?.message ?? humanInput.error?.message ?? null}
        onSubmit={async (requestId, response) => {
          await humanInput.respond(requestId, response);
        }}
        className="border-t border-og-border px-4 py-3"
      />
      <div className="shrink-0 border-t border-og-border px-4 py-4">
        <ChatComposer
          composer={composer}
          effectiveControl={effectiveControl}
          placeholder="Message this live session…"
          actionsStart={
            <SessionRealtimeControl
              sessionId={props.sessionId}
              sessionStatus={status}
              effectiveControl={effectiveControl}
              events={events.events}
              eventsReady={!events.initialLoading}
              codexConnected={mode === "mock"}
              realtimeAutostartModel={props.autostartModel ?? undefined}
              onRealtimeAutostartConsumed={props.onAutostartConsumed}
              controllerFactory={mode === "mock" ? deterministicRealtime.factory : undefined}
            />
          }
        />
      </div>
    </section>
  );
}

function NewSessionComposer(props: { onStart(model: SessionRealtimeModel): Promise<boolean> }) {
  const composer = useComposer(null, { draftPersistence: "disabled" });
  return (
    <section
      data-realtime-new-composer=""
      className="rounded-og-xl border border-og-border bg-og-surface-1 p-4 shadow-og-sm"
    >
      <h2 className="text-og-sm font-semibold">New-session composer</h2>
      <p className="mt-1 text-og-xs leading-5 text-og-fg-subtle">
        Starts with <code className="font-og-mono">startMode: &quot;realtime&quot;</code>, then
        mounts the same existing-session control with autostart.
      </p>
      <div className="mt-4">
        <ChatComposer
          composer={composer}
          placeholder="Optional first typed message…"
          actionsStart={
            <NewSessionRealtimeControl codexConnected={mode === "mock"} onStart={props.onStart} />
          }
        />
      </div>
    </section>
  );
}

function LiveConfiguration(props: {
  workspaceId: string;
  sessionId: string;
  onSubmit(workspaceId: string, sessionId: string): void;
}) {
  const [workspaceId, setWorkspaceId] = useState(props.workspaceId);
  const [sessionId, setSessionId] = useState(props.sessionId);
  const valid = useMemo(
    () => workspaceId.trim().length > 0 && sessionId.trim().length > 0,
    [sessionId, workspaceId],
  );
  return (
    <main className="og-root grid min-h-dvh place-items-center bg-og-bg p-6 text-og-fg">
      <form
        className="w-full max-w-lg rounded-og-xl border border-og-border bg-og-surface-1 p-6 shadow-og-lg"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) props.onSubmit(workspaceId.trim(), sessionId.trim());
        }}
      >
        <h1 className="text-og-lg font-semibold">Connect the live realtime demo</h1>
        <p className="mt-2 text-og-sm leading-6 text-og-fg-subtle">
          The browser uses the public SDK through the same-origin <code>/demo-api</code> proxy.
          Credentials remain on the server.
        </p>
        <label className="mt-5 grid gap-1.5 text-og-xs text-og-fg-muted">
          Workspace ID
          <input
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
            className="h-10 rounded-og-md border border-og-border bg-og-surface-2 px-3 font-og-mono text-og-sm text-og-fg outline-none focus:border-og-accent/50"
          />
        </label>
        <label className="mt-4 grid gap-1.5 text-og-xs text-og-fg-muted">
          Existing session ID
          <input
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            className="h-10 rounded-og-md border border-og-border bg-og-surface-2 px-3 font-og-mono text-og-sm text-og-fg outline-none focus:border-og-accent/50"
          />
        </label>
        <button
          type="submit"
          disabled={!valid}
          className="mt-5 h-10 rounded-og-md bg-og-accent px-4 text-og-sm font-medium text-og-accent-fg disabled:opacity-45"
        >
          Open reference consumer
        </button>
      </form>
    </main>
  );
}

function writeLiveLocation(workspaceId: string, sessionId: string): void {
  if (mode !== "live") return;
  const next = new URL(window.location.href);
  next.searchParams.set("mode", "live");
  next.searchParams.set("workspaceId", workspaceId);
  next.searchParams.set("sessionId", sessionId);
  window.history.replaceState(null, "", next);
}

const ACTIVE_CONTROL: EffectiveSessionControl = {
  state: "active",
  controlVersion: 0,
  controlEtag: "realtime-demo-active",
  directState: "active",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
};

createRoot(document.getElementById("root")!).render(<ReferenceConsumer />);
