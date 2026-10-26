// The Opengeni add-in for Excel: a task pane with the person's Opengeni chats,
// which also connects the open workbook so their agents (in this pane or any
// other chat) can work in it live through `excel_run`.
// It uses the published, scoped stylesheet, as any product embedding the
// session app does.
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@opengeni/react/compiled.css";
import {
  SessionApp,
  type MessageContextItem,
  type SessionAppSurfaces,
} from "@opengeni/react/session-app";
import { enableWorkbench } from "@opengeni/react/workbench";
import { OpenGeniClient, type Workspace } from "@opengeni/sdk";
import { lazy, StrictMode, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  describeWorkbook,
  office,
  officeTheme,
  selectionContextItem,
  watchOfficeTheme,
  watchSelection,
  WorkbookLink,
  workbookContextItem,
  type OfficeWorkbookInfo,
  type SelectionSnapshot,
  type WorkbookLinkState,
} from "@opengeni/sdk/office";
import { forgetToken, prepareSignIn, signIn, storedToken, type SignInRequest } from "./office-auth";
import "./pane.css";

const apiBaseUrl =
  String(import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/u, "") || window.location.origin;
/** The web app, where pages the pane doesn't show (settings, billing) open. */
const consoleUrl = window.location.origin;
const WORKSPACE_KEY = "opengeni.office.workspace";

// The session panel's terminal, desktop viewer, code editor and highlighted diffs.
enableWorkbench();

const surfaces: SessionAppSurfaces = {
  pdfPreview: lazy(() => import("../../src/components/artifacts/pdf-file-preview")),
};

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not kept across reloads.
  }
}

/** Opens a page in the person's browser: the task pane cannot navigate away. */
function openInBrowser(url: string): void {
  try {
    office().context.ui.openBrowserWindow(url);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

/** The pane's own screens (sign-in, errors), in Excel's theme like the app. */
function PaneScreen({ children }: { children: ReactNode }) {
  const theme = useOfficeTheme();
  const resolved =
    theme ?? (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
  return (
    <div
      className={`og-root pane-screen${resolved === "dark" ? " dark" : ""}`}
      data-og-theme={resolved}
    >
      {children}
    </div>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<SignInRequest | null>(null);
  useEffect(() => {
    if (request) return;
    let live = true;
    void prepareSignIn().then((prepared) => {
      if (live) setRequest(prepared);
    });
    return () => {
      live = false;
    };
  }, [request]);
  return (
    <PaneScreen>
      <main className="pane-center">
        <h1>Opengeni for Excel</h1>
        <p>Chat with your agents here. They can read and change this workbook while you watch.</p>
        <button
          type="button"
          className="pane-primary"
          disabled={pending || !request}
          onClick={() => {
            if (!request) return;
            setPending(true);
            setError(null);
            signIn(apiBaseUrl, request)
              .then(onSignedIn)
              .catch((caught: unknown) =>
                setError(caught instanceof Error ? caught.message : "Sign-in failed. Try again."),
              )
              .finally(() => {
                setPending(false);
                // A PKCE verifier is single-use.
                setRequest(null);
              });
          }}
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
        {error ? <p className="pane-error">{error}</p> : null}
        <p className="pane-note">
          New to Opengeni?{" "}
          <button type="button" className="pane-link" onClick={() => openInBrowser(consoleUrl)}>
            Create an account
          </button>
          , then come back here and sign in.
        </p>
      </main>
    </PaneScreen>
  );
}

/** A pane screen that can't show chats yet, with a way forward and a way out. */
function PaneNotice(props: {
  message: string;
  error?: boolean;
  openWeb?: boolean;
  onRetry: () => void;
  onSignOut: () => void;
}) {
  return (
    <PaneScreen>
      <main className="pane-center">
        <p className={props.error ? "pane-error" : undefined}>{props.message}</p>
        {props.openWeb ? (
          <button type="button" className="pane-primary" onClick={() => openInBrowser(consoleUrl)}>
            Open Opengeni
          </button>
        ) : null}
        <div className="pane-actions">
          <button type="button" className="pane-secondary" onClick={props.onRetry}>
            Try again
          </button>
          <button type="button" className="pane-secondary" onClick={props.onSignOut}>
            Sign out
          </button>
        </div>
      </main>
    </PaneScreen>
  );
}

function statusText(state: WorkbookLinkState, busy: boolean, workbook: OfficeWorkbookInfo | null) {
  const name = workbook?.name ?? "this workbook";
  if (state.status === "connected") return busy ? `Working in ${name}` : `Connected to ${name}`;
  if (state.status === "offline") return "Reconnecting…";
  if (state.status === "signed_out") return "Signed out";
  return "Connecting…";
}

/** Excel's theme, following it when it changes while the pane is open (Windows). */
function useOfficeTheme(): "light" | "dark" | undefined {
  const [theme, setTheme] = useState(officeTheme);
  useEffect(() => watchOfficeTheme(setTheme), []);
  return theme;
}

/** The workbook's current selection, re-read shortly after it or the sheet changes. */
function useWorkbookSelection(active: boolean): SelectionSnapshot | null {
  const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
  useEffect(() => (active ? watchSelection(setSelection) : undefined), [active]);
  return selection;
}

function WorkbookStatus(props: {
  link: WorkbookLinkState;
  busy: boolean;
  workbook: OfficeWorkbookInfo | null;
}) {
  const dotState =
    props.link.status === "connected"
      ? props.busy
        ? "busy"
        : "connected"
      : props.link.status === "offline"
        ? "offline"
        : "idle";
  return (
    <div className="pane-bar" role="status" aria-live="polite">
      <span className="pane-dot" data-state={dotState} aria-hidden="true" />
      <span className="pane-bar-text">{statusText(props.link, props.busy, props.workbook)}</span>
    </div>
  );
}

function PaneAccount(props: {
  workspaces: Workspace[];
  workspaceId: string;
  onWorkspace: (workspaceId: string) => void;
  onSignOut: () => void;
}) {
  return (
    <div className="pane-account">
      {props.workspaces.length > 1 ? (
        <select
          aria-label="Workspace"
          value={props.workspaceId}
          onChange={(event) => props.onWorkspace(event.target.value)}
        >
          {props.workspaces.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </select>
      ) : (
        <span className="pane-account-name">{props.workspaces[0]?.name}</span>
      )}
      <button type="button" onClick={props.onSignOut}>
        Sign out
      </button>
    </div>
  );
}

function Pane({ token, onSignedOut }: { token: string; onSignedOut: () => void }) {
  const client = useMemo(
    () => new OpenGeniClient({ baseUrl: apiBaseUrl, apiKey: token, onDeprecation: false }),
    [token],
  );
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(remembered(WORKSPACE_KEY));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [link, setLink] = useState<WorkbookLinkState>({ status: "connecting" });
  const [busy, setBusy] = useState(false);
  const [workbook, setWorkbook] = useState<OfficeWorkbookInfo | null>(null);
  const theme = useOfficeTheme();

  useEffect(() => {
    let live = true;
    client
      .listWorkspaces()
      .then((list) => {
        if (!live) return;
        setWorkspaces(list);
        setWorkspaceId((current) =>
          current && list.some((each) => each.id === current) ? current : (list[0]?.id ?? null),
        );
      })
      .catch((caught: unknown) => {
        if (!live) return;
        if ((caught as { status?: number })?.status === 401) onSignedOut();
        else setLoadError("Couldn't load your workspaces.");
      });
    return () => {
      live = false;
    };
  }, [client, onSignedOut, attempt]);
  const retry = useCallback(() => {
    setWorkspaces(null);
    setLoadError(null);
    setAttempt((count) => count + 1);
  }, []);

  // The workbook joins the chosen workspace: agents there can reach it.
  useEffect(() => {
    if (!workspaceId) return;
    const describe = async () => {
      const info = await describeWorkbook();
      setWorkbook(info);
      return info;
    };
    const instance = new WorkbookLink({
      ticket: () => client.createOfficeWorkbookTicket(workspaceId),
      baseUrl: apiBaseUrl,
      describe,
      onState: (state) => {
        setLink(state);
        if (state.status === "signed_out") onSignedOut();
      },
      onActivity: setBusy,
    });
    instance.start();
    return () => instance.stop();
  }, [client, workspaceId, onSignedOut]);

  const connectionId = link.status === "connected" ? link.connectionId : null;
  const selection = useWorkbookSelection(connectionId !== null);
  // Per-message context (never instructions), so the agent knows where it is
  // and what is selected without changing what earlier requests sent. The
  // selection shows as a pill the person can leave out.
  const messageContext = useMemo<MessageContextItem[] | undefined>(
    () =>
      workbook && connectionId
        ? [
            workbookContextItem({ workbook, connectionId, addinName: "Opengeni" }),
            ...(selection ? [selectionContextItem(selection, workbook.name)] : []),
          ]
        : undefined,
    [workbook, connectionId, selection],
  );
  const headers = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const signOut = useCallback(() => {
    void client.signOutNativeApp().catch(() => undefined);
    onSignedOut();
  }, [client, onSignedOut]);

  if (loadError) {
    return <PaneNotice message={loadError} error onRetry={retry} onSignOut={signOut} />;
  }
  if (!workspaces) return null;
  if (!workspaceId) {
    return (
      <PaneNotice
        message="Your account has no workspace yet. Finish setting up Opengeni on the web, then come back and try again."
        openWeb
        onRetry={retry}
        onSignOut={signOut}
      />
    );
  }
  return (
    <SessionApp
      apiBaseUrl={apiBaseUrl}
      consoleUrl={consoleUrl}
      headers={headers}
      workspaceId={workspaceId}
      preset="companion"
      theme={theme}
      surfaces={surfaces}
      messageContext={messageContext}
      onUnauthorized={onSignedOut}
      openUrl={openInBrowser}
      slots={{
        canvasBanners: <WorkbookStatus link={link} busy={busy} workbook={workbook} />,
        railFooter: (
          <PaneAccount
            workspaces={workspaces}
            workspaceId={workspaceId}
            onWorkspace={(next) => {
              setWorkspaceId(next);
              remember(WORKSPACE_KEY, next);
            }}
            onSignOut={signOut}
          />
        ),
      }}
    />
  );
}

function App() {
  const [token, setToken] = useState<string | null>(storedToken());
  const signedOut = useCallback(() => {
    forgetToken();
    setToken(null);
  }, []);
  return token ? <Pane token={token} onSignedOut={signedOut} /> : <SignIn onSignedIn={setToken} />;
}

void office()
  .onReady()
  .then(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
