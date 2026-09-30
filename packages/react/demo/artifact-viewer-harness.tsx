import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import type { SessionEvent, SessionQueueSnapshot } from "@opengeni/sdk";
import { SessionConversation, type OpenGeniViewerTarget } from "@opengeni/react";
import { SessionArtifactViewer } from "@opengeni/react/artifacts";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "../test/fake-client";
import "@opengeni/react/compiled.css";

/*
 * An embedding host: a narrow assistant panel on the left and the product's
 * main area on the right. Agent links and Site previews open
 * SessionArtifactViewer over the main area (full screen below 768px). The fake
 * client stands in for createSessionProxyHandler({ artifacts: true }).
 */

const EDITABLE_ID = "0123456789abcdef0123456789abcdef";
const SITE_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const control: SessionQueueSnapshot["effectiveControl"] = {
  state: "active",
  directState: "active",
  controlVersion: 1,
  controlEtag: "one",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
};
const reply = [
  "The weekly report and a dashboard are ready.",
  "",
  `[Open the weekly report](/workspaces/${WORKSPACE_ID}/artifacts/editable/${EDITABLE_ID})`,
  "",
  `[Open the dashboard](/workspaces/${WORKSPACE_ID}/artifacts/${SITE_ID})`,
  "",
  "```opengeni-site",
  JSON.stringify({ siteId: SITE_ID }),
  "```",
].join("\n");
const events: SessionEvent[] = [
  {
    id: "question",
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence: 1,
    type: "user.message",
    payload: { text: "Summarize this week's progress." },
    occurredAt: "2026-09-30T10:00:00Z",
  },
  {
    id: "answer",
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence: 2,
    type: "agent.message.completed",
    payload: { text: reply },
    occurredAt: "2026-09-30T10:01:00Z",
  },
];
const siteHtml = `<!doctype html><html><body style="font:15px system-ui;margin:24px;color:#1f2328">
<h1 style="font-size:24px;margin:0 0 8px">Weekly progress</h1><p>Tasks closed per team.</p>
${[82, 64, 41]
  .map(
    (w, i) =>
      `<div style="display:flex;align-items:center;gap:8px;margin:10px 0"><span style="width:64px">Team ${i + 1}</span><div style="height:14px;border-radius:7px;background:#2f6feb;width:${w}%"></div></div>`,
  )
  .join("")}</body></html>`;
const requests: { method: string; sessionHeader: string | undefined }[] = [];
Object.assign(window, { artifactViewerHarness: { requests } });
function siteClient(sessionHeader?: string) {
  const log = (method: string) => requests.push({ method, sessionHeader });
  return {
    async getWorkspaceArtifact() {
      log("getWorkspaceArtifact");
      const version = { id: VERSION_ID, revision: 2, requestedTools: [] };
      return {
        artifact: {
          id: SITE_ID,
          workspaceId: WORKSPACE_ID,
          title: "Weekly progress",
          status: "active",
          currentVersion: version,
          createdAt: "2026-09-30T10:00:00Z",
          updatedAt: "2026-09-30T10:00:00Z",
        },
        versions: [version],
      };
    },
    async getWorkspaceArtifactHtml() {
      log("getWorkspaceArtifactHtml");
      return siteHtml;
    },
    async getClientConfig() {
      return { artifacts: undefined } as never;
    },
    apiUrl: (path: string) => `/api/opengeni${path}`,
  };
}
const base = siteClient();
const client = fakeClient({
  ...(base as object),
  withHeaders: (headers: Record<string, string>) => ({
    ...siteClient(headers["x-opengeni-session-id"]),
    withHeaders: () => siteClient(headers["x-opengeni-session-id"]),
  }),
  getSession: async () =>
    ({ id: SESSION_ID, status: "idle", activeTurnId: null, effectiveControl: control }) as never,
  getQueue: async () => ({
    version: 1,
    effectiveControl: control,
    activePersonalConnections: [],
    stoppingPreviousAttempt: false,
    items: [],
    pendingInputs: [],
    pendingInputAttachment: null,
  }),
  getWorkspaceModelCatalog: async () => ({ models: [] }) as never,
  listHumanInputRequests: async () => [],
  listEvents: async () => events,
  streamEvents: async function* (_w: string, _s: string, options?: { signal?: AbortSignal }) {
    await new Promise<void>((resolve) =>
      options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
    yield* [] as SessionEvent[];
  },
} as never);

function useNarrow() {
  const query = "(max-width: 767px)";
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const change = () => setNarrow(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, []);
  return narrow;
}

function App() {
  const theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
  const [target, setTarget] = useState<OpenGeniViewerTarget | null>(null);
  const narrow = useNarrow();
  const viewer = target ? (
    <SessionArtifactViewer
      client={client}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      target={target}
      theme={theme}
      onClose={() => setTarget(null)}
      {...(narrow ? { onBack: () => setTarget(null) } : {})}
    />
  ) : null;
  return (
    <div
      data-og-theme={theme}
      className="og-root"
      style={{
        display: "flex",
        height: "100dvh",
        background: theme === "light" ? "#f4f5f7" : "#0b0d12",
        color: theme === "light" ? "#111" : "#eee",
        fontFamily: "system-ui",
      }}
    >
      <aside
        data-host-panel=""
        style={{
          width: narrow ? "100%" : "min(420px, 34%)",
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid rgba(128,128,128,.25)",
        }}
      >
        <SessionConversation
          sessionId={SESSION_ID}
          client={client}
          workspaceId={WORKSPACE_ID}
          onOpenArtifact={setTarget}
        />
      </aside>
      {narrow ? (
        viewer ? (
          <div
            role="dialog"
            aria-modal="true"
            data-host-viewer="sheet"
            style={{ position: "fixed", inset: 0, zIndex: 20, display: "flex" }}
          >
            {viewer}
          </div>
        ) : null
      ) : (
        <main data-host-main="" style={{ flex: 1, minWidth: 0, display: "flex" }}>
          {viewer ?? <div style={{ margin: "auto", opacity: 0.6 }}>Product page content</div>}
        </main>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
