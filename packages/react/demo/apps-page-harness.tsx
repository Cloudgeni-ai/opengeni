// The real Apps page (AppsRoute): installed apps with their version,
// Modified and Update available, ready-made apps to add, and the install and
// update dialogs. A synthetic client answers, so nothing reaches an API.
//   ?theme=light|dark   ?apps=none   ?view=list
import type { AppPackageStatus, AppPackageUpgradePlan } from "@opengeni/sdk";
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniProvider } from "@opengeni/react";
import { AppContext } from "@opengeni/react/app/app-context";
import { AppHostProvider } from "@opengeni/react/app/lib/app-host";
import { useMemoryNavigation } from "@opengeni/react/app/embed/memory-navigation";
import { AppsRoute } from "@opengeni/react/app/routes/apps";
import workSummary from "../../core/src/app-templates/work-summary.app.json";
import issueTracker from "../../core/src/app-templates/issue-tracker.app.json";
import incidentLog from "../../core/src/app-templates/incident-log.app.json";
import decisionLog from "../../core/src/app-templates/decision-log.app.json";
import { MockOpenGeniClient } from "./mock";
import "./agent-settings.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const params = new URLSearchParams(window.location.search);
const dark = params.get("theme") === "dark";
const noApps = params.get("apps") === "none";
if (params.get("view") === "list")
  localStorage.setItem("opengeni:artifact-library:view:v1", "list");

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const app = (id: string, title: string, updated: number) => ({
  kind: "site",
  id,
  title,
  status: "active",
  visibility: "workspace_shared",
  createdAt: day(updated + 3),
  updatedAt: day(updated),
  pinned: false,
  sourceSessionId: null,
  versionId: null,
});
const APPS = noApps
  ? []
  : [
      app("a1111111-1111-4111-8111-111111111111", "Work summary", 0),
      app("a2222222-2222-4222-8222-222222222222", "Issue tracker", 2),
      app("a3333333-3333-4333-8333-333333333333", "Launch checklist", 5),
    ];
const status = (
  appId: string,
  title: string,
  packageId: string,
  extra: Partial<AppPackageStatus>,
): AppPackageStatus => ({
  appId,
  title,
  packageId,
  packageVersion: "1.0.0",
  archived: false,
  modified: false,
  skills: [],
  automations: [],
  previous: null,
  update: null,
  ...extra,
});
const STATUS: AppPackageStatus[] = noApps
  ? []
  : [
      status(APPS[0]!.id, "Work summary", workSummary.package.packageId, {
        packageVersion: "0.9.0",
        skills: [{ id: "s1", name: "work-summary", modified: true }],
        automations: [{ id: "t1", name: "Update the work summary" }],
        update: { templateKey: "work-summary", packageVersion: "1.0.0" },
        previous: {
          id: "5f0c2b1e-3d4a-4b6c-8e9f-0a1b2c3d4e5f",
          packageVersion: "0.8.0",
          savedAt: day(9),
        },
      }),
      status(APPS[1]!.id, "Issue tracker", issueTracker.package.packageId, { modified: true }),
    ];
const PLAN: AppPackageUpgradePlan = {
  version: { changed: true, html: true, source: false, tools: false, assets: false },
  package: { id: workSummary.package.packageId, current: workSummary.package.packageId },
  tools: { added: [], removed: [] },
  collections: { added: [], changed: ["entries"], unchanged: [], kept: [] },
  migrations: { applied: [], new: [], conflicting: [] },
  queries: { added: [], changed: [], removed: [], unchanged: [] },
  syncs: { added: [], changed: [], unchanged: [], kept: [] },
  packageVersion: { current: "0.9.0", next: "1.0.0" },
  skills: { added: [], changed: ["work-summary"], unchanged: [], kept: [] },
  automations: { added: [], kept: ["Update the work summary"] },
  localChanges: { app: false, skills: ["work-summary"] },
  destructive: [],
  conflicts: [],
  problems: [],
};

class PreviewClient extends MockOpenGeniClient {
  async listArtifactCatalog() {
    return { items: APPS, nextCursor: null } as never;
  }
  async listAppPackageStatus() {
    return STATUS;
  }
  async listAppTemplates() {
    return [workSummary, issueTracker, incidentLog, decisionLog] as never;
  }
  async upgradeAppPackage(_workspaceId: string, appId: string, request: { previous?: boolean }) {
    const plan = request.previous
      ? { ...PLAN, packageVersion: { current: "0.9.0", next: "0.8.0" } }
      : PLAN;
    return {
      app: { id: appId },
      dryRun: true,
      applied: false,
      plan,
      upgraded: {},
      notUpgraded: [],
    } as never;
  }
  async installAppPackage() {
    return new Promise(() => undefined) as never;
  }
}

function Preview() {
  const client = useMemo(() => new PreviewClient(), []);
  const navigation = useMemoryNavigation({
    initialPath: `/workspaces/${WORKSPACE_ID}/apps`,
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
      <AppHostProvider
        host={{ api: { apiBaseUrl: "https://app.opengeni.ai" } as never, navigation }}
      >
        <AppContext.Provider value={context}>
          <div className="og-root min-h-screen bg-og-bg text-og-fg" data-shot="">
            <AppsRoute workspaceId={WORKSPACE_ID} />
          </div>
        </AppContext.Provider>
      </AppHostProvider>
    </OpenGeniProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
