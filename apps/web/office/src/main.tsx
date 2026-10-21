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
import { runOfficeCode } from "./executor";
import { forgetToken, prepareSignIn, signIn, storedToken, type SignInRequest } from "./office-auth";
import {
  readSelection,
  selectionContextItem,
  type SelectionRequestContext,
  type SelectionSnapshot,
} from "./selection-context";
import {
  describeWorkbook,
  WorkbookLink,
  type WorkbookInfo,
  type WorkbookLinkState,
} from "./workbook-link";
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
      </main>
    </PaneScreen>
  );
}

function statusText(state: WorkbookLinkState, busy: boolean, workbook: WorkbookInfo | null) {
  const name = workbook?.name ?? "this workbook";
  if (state.status === "connected") return busy ? `Working in ${name}` : `Connected to ${name}`;
  if (state.status === "offline") return "Reconnecting…";
  if (state.status === "signed_out") return "Signed out";
  return "Connecting…";
}

/** Light or dark from Excel's own theme (Office 2016+ reports its body color). */
function officeTheme(): "light" | "dark" | undefined {
  const color = Office.context.officeTheme?.bodyBackgroundColor;
  const match = color ? /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/iu.exec(color) : null;
  if (!match) return undefined;
  const [r, g, b] = match.slice(1).map((part) => parseInt(part, 16) / 255) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5 ? "dark" : "light";
}

/** Excel's theme, following it when it changes while the pane is open (Windows). */
function useOfficeTheme(): "light" | "dark" | undefined {
  const [theme, setTheme] = useState(officeTheme);
  useEffect(() => {
    const handler = () => setTheme(officeTheme());
    const event = Office.EventType.OfficeThemeChanged ?? "officeThemeChanged";
    const document = Office.context.document;
    try {
      document?.addHandlerAsync?.(event, handler);
    } catch {
      // Hosts without the event keep the theme they opened with.
    }
    return () => {
      try {
        document?.removeHandlerAsync?.(event, { handler });
      } catch {
        // Nothing registered.
      }
    };
  }, []);
  return theme;
}

/** The workbook's current selection, re-read shortly after it or the sheet changes. */
function useWorkbookSelection(active: boolean): SelectionSnapshot | null {
  const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    let reading = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        const next = await Excel.run((context) =>
          readSelection(context as unknown as SelectionRequestContext),
        );
        if (live) setSelection(next);
      } catch {
        // Keep the last selection; the next change reads again.
      } finally {
        reading = false;
        if (again && live) {
          again = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void read(), 150);
    };
    void read();
    const event = Office.EventType.DocumentSelectionChanged ?? "documentSelectionChanged";
    const document = Office.context.document;
    try {
      document?.addHandlerAsync?.(event, schedule);
    } catch {
      // Hosts without the event keep the selection read when the pane connected.
    }
    return () => {
      live = false;
      clearTimeout(timer);
      try {
        document?.removeHandlerAsync?.(event, { handler: schedule });
      } catch {
        // Nothing registered.
      }
    };
  }, [active]);
  return selection;
}

function WorkbookStatus(props: {
  link: WorkbookLinkState;
  busy: boolean;
  workbook: WorkbookInfo | null;
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
  const [link, setLink] = useState<WorkbookLinkState>({ status: "connecting" });
  const [busy, setBusy] = useState(false);
  const [workbook, setWorkbook] = useState<WorkbookInfo | null>(null);
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
  }, [client, onSignedOut]);

  useEffect(() => {
    const describe = async () => {
      const info = await describeWorkbook();
      setWorkbook(info);
      return info;
    };
    const instance = new WorkbookLink({
      apiBaseUrl,
      token: () => token,
      describe,
      run: (code) => runOfficeCode(code, (batch) => Excel.run(batch), Excel),
      onState: (state) => {
        setLink(state);
        if (state.status === "signed_out") onSignedOut();
      },
      onActivity: setBusy,
    });
    instance.start();
    return () => instance.stop();
  }, [token, onSignedOut]);

  const connectionId = link.status === "connected" ? link.connectionId : null;
  const selection = useWorkbookSelection(connectionId !== null);
  // Per-message context (never instructions), so the agent knows where it is
  // and what is selected without changing what earlier requests sent. The
  // selection shows as a pill the person can leave out.
  const messageContext = useMemo<MessageContextItem[] | undefined>(
    () =>
      workbook && connectionId
        ? [
            {
              id: "excel-workbook",
              text: `The person is writing from the Opengeni add-in in their open Excel workbook "${workbook.name}" (${workbook.app}). To read or change it, call excel_run with workbook "${connectionId}".`,
            },
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
    return (
      <PaneScreen>
        <main className="pane-center">
          <p className="pane-error">{loadError}</p>
        </main>
      </PaneScreen>
    );
  }
  if (!workspaces) return null;
  if (!workspaceId) {
    return (
      <PaneScreen>
        <main className="pane-center">
          <p>Your account has no workspace yet. Open Opengeni on the web to set one up.</p>
        </main>
      </PaneScreen>
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
      openUrl={(url) => {
        // The task pane cannot navigate away; open the browser instead.
        try {
          Office.context.ui.openBrowserWindow(url);
        } catch {
          window.open(url, "_blank", "noopener");
        }
      }}
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

void Office.onReady().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
