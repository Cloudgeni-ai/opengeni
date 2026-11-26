// The real app page (AppPage), as the sidebar, Cmd-K and the Apps page open
// it: its header (title, version, "…") above the app. The Work summary
// ready-made app runs on its sample records; nothing reaches an API.
//   ?theme=light|dark
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniProvider } from "@opengeni/react";
import { AppContext } from "@opengeni/react/app/app-context";
import { AppHostProvider } from "@opengeni/react/app/lib/app-host";
import { templatePreviewFetch } from "../src/app/lib/app-template-preview";
import { publishSiteSidebarBridge } from "../src/app/lib/site-sidebar-bridge";
import { useMemoryNavigation } from "@opengeni/react/app/embed/memory-navigation";
import { AppPage } from "@opengeni/react/app/routes/app-page-view";
import workSummary from "../../core/src/app-templates/work-summary.app.json";
import { MockOpenGeniClient } from "./mock";
import "./agent-settings.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const APP_ID = "a1111111-1111-4111-8111-111111111111";
const dark = new URLSearchParams(window.location.search).get("theme") === "dark";
// The sidebar's Pin and Archive, as the console's sidebar offers them.
publishSiteSidebarBridge({
  workspaceId: WORKSPACE_ID,
  pinnedSiteIds: new Set(),
  pin: () => undefined,
  archive: () => undefined,
});
// The app follows the console's appearance.
localStorage.setItem("opengeni.appearance", dark ? "dark" : "light");
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const version = (revision: number) => ({
  id: `v${revision}`,
  revision,
  requestedTools: [],
  createdAt: day(4 - revision),
  title: "Work summary",
});
const DETAIL = {
  artifact: {
    kind: "site",
    id: APP_ID,
    workspaceId: WORKSPACE_ID,
    title: "Work summary",
    status: "active",
    visibility: "workspace_shared",
    createdAt: day(4),
    updatedAt: day(0),
    currentVersion: version(2),
  },
  versions: [version(2), version(1)],
  events: [],
};
const html = workSummary.package.app.html;
const serve = templatePreviewFetch(workSummary.preview.records as never);

class PreviewClient extends MockOpenGeniClient {
  tools = { forWorkspace: () => ({}) } as never;
  async getWorkspaceArtifact() {
    return DETAIL as never;
  }
  async getWorkspaceArtifactHtml() {
    return html;
  }
  async getSitePublicationLink(): Promise<never> {
    throw Object.assign(new Error("Not found"), { status: 404 });
  }
}

// The app's Site Data calls, answered from the sample records.
const api = {
  apiBaseUrl: "https://app.opengeni.ai",
  requestResponse: async (path: string, init?: RequestInit) => {
    const at = path.indexOf("/data/");
    return serve({
      type: "opengeni:site-http",
      requestId: "preview",
      path: `/v1/workspaces/site-host/published-artifacts/current${at < 0 ? path : path.slice(at)}`,
      method: init?.method ?? "GET",
      headers: [],
      body: typeof init?.body === "string" ? init.body : undefined,
    } as never);
  },
  request: async () => {
    throw new Error("Preview only");
  },
};

function Preview() {
  const client = useMemo(() => new PreviewClient(), []);
  const navigation = useMemoryNavigation({
    initialPath: `/workspaces/${WORKSPACE_ID}/apps/${APP_ID}`,
    consoleOrigin: window.location.origin,
    handles: () => true,
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-og-theme", dark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", dark);
  }, []);
  const context = useMemo(
    () =>
      ({
        client,
        accessKeyVersion: 0,
        busy: false,
        accessContext: {
          mode: "managed",
          subjectId: "user:kari",
          workspaceGrants: [
            {
              workspaceId: WORKSPACE_ID,
              subjectId: "user:kari",
              principalKind: "human_session",
              permissions: [
                "sessions:read",
                "sessions:create",
                "artifacts:read",
                "artifacts:publish",
              ],
            },
          ],
        },
        workspaces: [
          {
            id: WORKSPACE_ID,
            accountId: "account-preview",
            kind: "shared",
            name: "Acme",
            settings: {},
            agentInstructions: null,
          },
        ],
        clientConfig: {},
        managedSelfContext: null,
      }) as never,
    [client],
  );
  return (
    <OpenGeniProvider client={client as never} workspaceId={WORKSPACE_ID}>
      <AppHostProvider host={{ api: api as never, navigation }}>
        <AppContext.Provider value={context}>
          <div className="og-root flex h-screen bg-og-bg text-og-fg" data-shot="">
            <AppPage workspaceId={WORKSPACE_ID} appId={APP_ID} siteHref="/" active />
          </div>
        </AppContext.Provider>
      </AppHostProvider>
    </OpenGeniProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
