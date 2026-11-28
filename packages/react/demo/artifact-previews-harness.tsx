// The real artifact library gallery with realistic Sites (an issue tracker and
// a work summary from the app templates, a script-drawn dashboard, a page that
// draws nothing) and a document, spreadsheet and presentation, whose pictures
// come from core's preview drawing. A synthetic client answers.
//   ?theme=light|dark   ?frameHost=<origin of a served HTML frame host>
import type { ArtifactCatalogItem } from "@opengeni/sdk";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniProvider } from "@opengeni/react";
import { AppContext } from "@opengeni/react/app/app-context";
import { AppHostProvider } from "@opengeni/react/app/lib/app-host";
import { configureContentHosting } from "@opengeni/react/app/lib/content-hosting";
import { defaultArtifactFilters } from "@opengeni/react/app/lib/artifact-catalog";
import { useMemoryNavigation } from "@opengeni/react/app/embed/memory-navigation";
import { ArtifactLibrary } from "@opengeni/react/app/components/artifacts/artifact-library";
import workSummary from "../../core/src/app-templates/work-summary.app.json";
import issueTracker from "../../core/src/app-templates/issue-tracker.app.json";
import { MockOpenGeniClient } from "./mock";
import { PREVIEW_PICTURES, PREVIEW_SITES } from "./artifact-previews-fixtures";
import "./agent-settings.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const params = new URLSearchParams(window.location.search);
const dark = params.get("theme") === "dark";
const frameHost = params.get("frameHost");
if (frameHost) configureContentHosting({ htmlFrameHost: frameHost });
localStorage.setItem("opengeni:artifact-library:view:v1", "gallery");

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const item = (
  id: string,
  kind: ArtifactCatalogItem["kind"],
  title: string,
  updated: number,
): ArtifactCatalogItem =>
  ({
    kind,
    id,
    title,
    status: "active",
    visibility: "workspace",
    createdAt: day(updated + 3),
    updatedAt: day(updated),
    pinned: false,
    ...(kind === "site" ? { versionId: `v-${id}` } : {}),
  }) as ArtifactCatalogItem;

const SITE_HTML: Record<string, string> = {
  tracker: issueTracker.package.app.html,
  summary: workSummary.package.app.html,
  ...PREVIEW_SITES,
};
const ITEMS: ArtifactCatalogItem[] = [
  item("tracker", "site", "Issue tracker", 0),
  item("deployments", "site", "Deployments", 0),
  item("benchmarks", "site", "Opengeni benchmark results", 1),
  item("summary", "site", "Work summary", 2),
  item("ideas", "site", "Opengeni ideas", 3),
  item("draft", "site", "Draft report", 5),
  item("plan", "document", "Q3 launch plan", 1),
  item("forecast", "spreadsheet", "Revenue forecast", 2),
  item("review", "presentation", "Quarterly review", 4),
];

class PreviewClient extends MockOpenGeniClient {
  async getWorkspaceArtifactHtml(_workspaceId: string, id: string) {
    return SITE_HTML[id] ?? "";
  }
  async getEditableArtifactPreview(_workspaceId: string, id: string) {
    const svg = PREVIEW_PICTURES[id];
    if (!svg) throw new Error("no picture");
    return svg;
  }
}

function Preview() {
  const client = useMemo(() => new PreviewClient(), []);
  const [filters, setFilters] = useState(defaultArtifactFilters);
  const navigation = useMemoryNavigation({
    initialPath: `/workspaces/${WORKSPACE_ID}/artifacts`,
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
              permissions: ["sessions:read", "artifacts:read", "artifacts:publish"],
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
          <div className="og-root min-h-screen bg-og-bg p-6 text-og-fg" data-shot="">
            <ArtifactLibrary
              workspaceId={WORKSPACE_ID}
              items={ITEMS}
              filters={filters}
              onFiltersChange={setFilters}
              loading={false}
              onRetry={() => {}}
            />
          </div>
        </AppContext.Provider>
      </AppHostProvider>
    </OpenGeniProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
