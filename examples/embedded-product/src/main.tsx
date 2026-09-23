import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ConnectController,
  authorizeConnectAttempt,
  createBrowserConnectNavigation,
  findConnectRecoveryAccount,
  type ConnectAttempt,
} from "@opengeni/connect";
import { ConnectPanel } from "@opengeni/react/connect";
import { SiteDetail, SiteList } from "@opengeni/react/sites";
import "@opengeni/react/connect.css";
import { connect, sites, hostRequest } from "./transport";
import "./styles.css";
import { SchedulesPanel } from "./schedules-panel";
const SessionPanel = lazy(() =>
  import("./session-panel").then((module) => ({ default: module.SessionPanel })),
);

type HostContext = { workspaceId: string; returnUrl: string };
function Product({ context }: { context: HostContext }) {
  const [controller] = useState(() => new ConnectController(connect, context.workspaceId));
  const [pending, setPending] = useState<ConnectAttempt[]>([]);
  const [siteId, setSiteId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("site"),
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [mode, setMode] = useState<"popup" | "redirect">("popup");
  const [error, setError] = useState(false);
  useEffect(() => () => controller.dispose(), [controller]);
  const loadPending = useCallback(async () => {
    try {
      setPending(await connect.pending(context.workspaceId));
      setError(false);
    } catch {
      setError(true);
    }
  }, [context.workspaceId]);
  useEffect(() => {
    void loadPending();
  }, [loadPending]);
  return (
    <main>
      <header>
        <p className="eyebrow">YOUR PRODUCT / WORKSPACE</p>
        <h1>Work, connected.</h1>
        <p>Your integrations and shared Sites, without a console handoff.</p>
      </header>
      <aside>
        Local development example. The host backend owns identity; provider availability depends on
        your OpenGeni deployment.
      </aside>
      {error && (
        <p role="alert">Request could not be completed. Reload setup status before retrying.</p>
      )}
      <label>
        Authorization navigation
        <select
          value={mode}
          onChange={(event) => setMode(event.target.value as "popup" | "redirect")}
        >
          <option value="popup">Popup</option>
          <option value="redirect">Full redirect (use if popups are blocked)</option>
        </select>
      </label>
      <section id="connection-recovery" tabIndex={-1} aria-label="Connection setup">
        <ConnectPanel
          controller={controller}
          returnUrl={context.returnUrl}
          onAuthorize={(attempt) => {
            // Synchronous call retains the click gesture for popup opening. Recovery
            // uses authenticated pending attempts, never return URL parameters.
            return authorizeConnectAttempt(
              connect,
              attempt,
              createBrowserConnectNavigation(window),
              {
                mode,
              },
            ).then(async (result) => {
              if (result) await controller.recover(result.id);
            });
          }}
        />
      </section>
      <section aria-label="Resume setup">
        <h2>Continue setup</h2>
        <button onClick={() => void loadPending()}>Reload pending attempts</button>
        <ul>
          {pending.map((attempt) => (
            <li key={attempt.id}>
              <button
                onClick={() => {
                  void controller.recover(attempt.id).catch(() => setError(true));
                }}
              >
                {attempt.providerId} — {attempt.state.replaceAll("_", " ")}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="og-connect">
        <h2>Shared Sites</h2>
        <p>Sites are shared with workspace members, even when their source session is private.</p>
        {siteId ? (
          <>
            <button onClick={() => setSiteId(null)}>Back to Sites</button>
            <SiteDetail client={sites} workspaceId={context.workspaceId} siteId={siteId} />
            <button
              onClick={() => {
                void (async () => {
                  const { artifact: site } = await sites.getWorkspaceArtifact(
                    context.workspaceId,
                    siteId,
                  );
                  if (!site.currentVersion) throw new Error("No current Site version");
                  const created = await hostRequest<{ id: string }>(
                    `sites/${encodeURIComponent(site.id)}/edit-session`,
                    "POST",
                    {
                      expectedCurrentVersionId: site.currentVersion.id,
                      idempotencyKey: crypto.randomUUID(),
                    },
                  );
                  setSessionId(created.id);
                })().catch(() => setError(true));
              }}
            >
              Edit with agent
            </button>
          </>
        ) : (
          <>
            <label>
              Inventory
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as typeof status)}
              >
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            <SiteList
              client={sites}
              workspaceId={context.workspaceId}
              status={status}
              onOpen={(site) => setSiteId(site.id)}
            />
          </>
        )}
      </section>
      <SchedulesPanel />
      {sessionId && (
        <>
          <button onClick={() => setSessionId(null)}>Close editing session view</button>
          <Suspense fallback={<p role="status">Opening session…</p>}>
            <SessionPanel
              key={sessionId}
              workspaceId={context.workspaceId}
              sessionId={sessionId}
              onReconnect={async (item) => {
                if (item.authoritySource === "host") {
                  if (!item.authorizationUrl)
                    throw new Error("Reconnect this account in the product's account settings.");
                  const destination = new URL(item.authorizationUrl, window.location.origin);
                  if (
                    !["https:", "http:"].includes(destination.protocol) ||
                    destination.username ||
                    destination.password
                  )
                    throw new Error("Account recovery address unavailable.");
                  window.location.assign(destination.href);
                  return;
                }
                const account = findConnectRecoveryAccount(
                  await connect.accounts(context.workspaceId),
                  item.connectionId,
                );
                if (account)
                  await controller.begin({
                    providerId: account.providerId,
                    ownership: account.ownership,
                    reconnectAccountId: account.id,
                    returnUrl: context.returnUrl,
                    idempotencyKey: crypto.randomUUID(),
                  });
                document.getElementById("connection-recovery")?.focus();
                document.getElementById("connection-recovery")?.scrollIntoView({ block: "start" });
                if (!account)
                  throw new Error(
                    "The original account is unavailable. Choose an account explicitly in connection setup.",
                  );
              }}
            />
          </Suspense>
        </>
      )}
    </main>
  );
}
function App() {
  const [context, setContext] = useState<HostContext | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void hostRequest<HostContext>("context", "GET", undefined, { signal: abort.signal })
      .then(setContext)
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => abort.abort();
  }, []);
  return error ? (
    <main role="alert">Host authentication or backend configuration is unavailable.</main>
  ) : context ? (
    <Product key={context.workspaceId} context={context} />
  ) : (
    <main role="status">Opening workspace…</main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
