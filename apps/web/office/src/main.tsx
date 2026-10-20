// The Opengeni add-in for Excel: a task pane with the person's Opengeni chats,
// which also connects the open workbook so their agents (in this pane or any
// other chat) can work in it live through `excel_run`.
import {
  OpenGeniChat,
  OpenGeniProvider,
  type OpenGeniChatCreateOptions,
} from "@opengeni/react/session-ui";
import "@opengeni/react/compiled.css";
import { OpenGeniClient, type Workspace } from "@opengeni/sdk";
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { runOfficeCode } from "./executor";
import { forgetToken, prepareSignIn, signIn, storedToken, type SignInRequest } from "./office-auth";
import {
  describeWorkbook,
  WorkbookLink,
  type WorkbookInfo,
  type WorkbookLinkState,
} from "./workbook-link";
import "./pane.css";

const apiBaseUrl =
  String(import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/u, "") || window.location.origin;
const WORKSPACE_KEY = "opengeni.office.workspace";

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
  );
}

function statusText(state: WorkbookLinkState, busy: boolean, workbook: WorkbookInfo | null) {
  const name = workbook?.name ?? "this workbook";
  if (state.status === "connected") return busy ? `Working in ${name}` : `Connected to ${name}`;
  if (state.status === "offline") return "Reconnecting…";
  if (state.status === "signed_out") return "Signed out";
  return "Connecting…";
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
  const linkRef = useRef<WorkbookLink | null>(null);

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
    linkRef.current = instance;
    instance.start();
    return () => instance.stop();
  }, [token, onSignedOut]);

  const connectionId = link.status === "connected" ? link.connectionId : null;
  // Per-message context (never instructions), so the agent knows where it is
  // without changing what earlier requests sent.
  const modelContext = useCallback(
    () =>
      workbook && connectionId
        ? `The person is writing from the Opengeni add-in in their open Excel workbook "${workbook.name}" (${workbook.app}, workbook id ${connectionId}). Use excel_run to read or change it.`
        : undefined,
    [workbook, connectionId],
  );
  const modelContextRef = useRef(modelContext);
  modelContextRef.current = modelContext;

  const createSession = useCallback(
    async (initialMessage: string, idempotencyKey: string, options: OpenGeniChatCreateOptions) => {
      if (!workspaceId) throw new Error("Choose a workspace first.");
      const context = modelContextRef.current();
      const created = await client.createSession(workspaceId, {
        ...(options.startMode === "realtime" ? {} : { initialMessage }),
        idempotencyKey,
        ...options,
        ...(context && options.startMode !== "realtime" ? { modelContext: context } : {}),
      } as Parameters<OpenGeniClient["createSession"]>[1]);
      return created.id;
    },
    [client, workspaceId],
  );

  const dotState =
    link.status === "connected"
      ? busy
        ? "busy"
        : "connected"
      : link.status === "offline"
        ? "offline"
        : "idle";

  return (
    <div className="pane">
      <header className="pane-bar">
        <div className="pane-bar-status" role="status" aria-live="polite">
          <span className="pane-dot" data-state={dotState} aria-hidden="true" />
          <span>{statusText(link, busy, workbook)}</span>
        </div>
        {workspaces && workspaces.length > 1 ? (
          <select
            aria-label="Workspace"
            value={workspaceId ?? ""}
            onChange={(event) => {
              setWorkspaceId(event.target.value);
              remember(WORKSPACE_KEY, event.target.value);
            }}
          >
            {workspaces.map((each) => (
              <option key={each.id} value={each.id}>
                {each.name}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          onClick={() => {
            void client.signOutNativeApp().catch(() => undefined);
            onSignedOut();
          }}
        >
          Sign out
        </button>
      </header>
      <div className="pane-chat">
        {loadError ? (
          <main className="pane-center">
            <p className="pane-error">{loadError}</p>
          </main>
        ) : workspaceId ? (
          <OpenGeniProvider client={client} workspaceId={workspaceId}>
            <OpenGeniChat
              key={workspaceId}
              createSession={createSession}
              conversationProps={{
                composerOptions: {
                  sendExtras: () => ({ modelContext: modelContextRef.current() }),
                },
              }}
            />
          </OpenGeniProvider>
        ) : workspaces ? (
          <main className="pane-center">
            <p>Your account has no workspace yet. Open Opengeni on the web to set one up.</p>
          </main>
        ) : null}
      </div>
    </div>
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
