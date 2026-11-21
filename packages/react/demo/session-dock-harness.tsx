// The chat's side panel as the app shows it (relevant tabs only, "+" for the
// rest), with the app's stylesheet stack, to preview it with real components.
// A state-driven mock client answers the workbench reads; nothing reaches an
// API.
//   ?pr=1          the chat has a linked pull request (PR tab first)
//   ?state=<key>   a workbench dock state (default branch-review)
//   ?theme=light   light theme (default dark)
//   ?artifacts=0   the chat has no artifacts yet (Artifacts in the "+" menu)
//   ?state=empty   nothing changed (with ?artifacts=0: the empty panel)
//   ?closed=1      the panel starts closed; ?hint=1 adds the header's new-content dot
//   ?tab=<id>      the tab the person last opened (e.g. browser)
import type { SessionLinkWithStatus, SessionPullRequestDetail } from "@opengeni/sdk";
import { GitPullRequestIcon, PanelsTopLeftIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniProvider, SandboxWorkspace, useSessionEvents } from "@opengeni/react";
import { enablePierreDiffs } from "@opengeni/react/diffs";
import { PullRequestView } from "@opengeni/react/app/components/session/pull-request-panel";
import {
  SessionEditableArtifactsWorkspace,
  type SessionEditableArtifactSummary,
} from "@opengeni/react/app/components/session/editable-artifacts-workspace";
import { AppContext } from "@opengeni/react/app/app-context";
import { AppHostProvider } from "@opengeni/react/app/lib/app-host";
import { useMemoryNavigation } from "@opengeni/react/app/embed/memory-navigation";
import { SessionHeader } from "@opengeni/react/app/components/rail/session-header";
// Vite's `?worker` transform synthesizes this default export.
// oxlint-disable-next-line import/default
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { DOCK_SESSION_ID, DOCK_STATES, DockStateMockClient } from "./workbench-dock-states";
import { enableWorkbenchDemoPeers } from "./workbench-peers";
import "./agent-settings.css";

enableWorkbenchDemoPeers();
enablePierreDiffs({ worker: () => new DiffsWorker() });

const params = new URLSearchParams(window.location.search);
const withPr = params.get("pr") === "1";
const light = params.get("theme") === "light";
const withArtifacts = params.get("artifacts") !== "0";
const startClosed = params.get("closed") === "1";
const withHint = params.get("hint") === "1";
const rememberedTab = params.get("tab");
const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const state = DOCK_STATES[params.get("state") ?? "branch-review"] ?? DOCK_STATES["branch-review"]!;
const client = new DockStateMockClient(state);
document.documentElement.setAttribute("data-og-theme", light ? "light" : "dark");
document.documentElement.classList.toggle("dark", !light);

const PR_URL = "https://github.com/acme/api/pull/482";
const link: SessionLinkWithStatus = {
  id: "link-pr",
  url: PR_URL,
  title: "Harden the API: CORS allowlist, helmet and rate limits",
  kind: "pull_request",
  provider: "github",
  ref: "acme/api#482",
  addedBy: "automatic",
  addedAt: "2026-11-21T09:00:00.000Z",
  status: {
    state: "open",
    label: null,
    title: "Harden the API: CORS allowlist, helmet and rate limits",
    checks: "passing",
    review: "approved",
  },
};
const files = state.gitDiff;
const detail: SessionPullRequestDetail = {
  url: PR_URL,
  owner: "acme",
  repo: "api",
  number: 482,
  title: "Harden the API: CORS allowlist, helmet and rate limits",
  state: "open",
  author: { login: "opengeni-agent", avatarUrl: null },
  base: "main",
  head: "security-hardening",
  createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  mergedAt: null,
  body: "Locks CORS to an allowlist, adds helmet and rate limiting, and turns on instance monitoring.\n\n- `ALLOWED_ORIGINS` configures the allowlist\n- Terraform enables monitoring and EBS optimisation",
  additions: files.reduce((sum, file) => sum + file.additions, 0),
  deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  changedFiles: files.length,
  commitCount: 3,
  commentCount: 2,
  mergeable: true,
  checks: "passing",
  review: "approved",
  files,
  filesTruncated: false,
  commits: [
    { sha: "a1b2c3d", message: "Lock CORS to an allowlist", author: "opengeni-agent", date: null },
    {
      sha: "d4e5f6a",
      message: "Add helmet and rate limiting",
      author: "opengeni-agent",
      date: null,
    },
    { sha: "b7c8d9e", message: "Enable instance monitoring", author: "opengeni-agent", date: null },
  ],
  comments: [
    {
      id: "review:1",
      kind: "review",
      author: { login: "bendik", avatarUrl: null },
      body: "Looks good. Ship it.",
      reviewState: "approved",
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
      url: null,
    },
  ],
  checkRuns: [
    { name: "Unit tests", state: "passing", url: null },
    { name: "Typecheck", state: "passing", url: null },
  ],
};

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
const artifacts: SessionEditableArtifactSummary[] = (
  [
    ["site-1", "site", "API status app", 1],
    ["doc-1", "document", "Security hardening notes", 2],
    ["sheet-1", "spreadsheet", "Rate limit budget", 3],
    ["img-1", "image", "Architecture diagram", 5],
    ["deck-1", "presentation", "Hardening review", 26],
  ] as const
).map(([id, modality, title, hours]) => ({
  id,
  modality,
  title,
  catalogItem: {
    id,
    kind: modality === "image" ? "file" : modality,
    title,
    createdAt: hoursAgo(hours + 1),
    updatedAt: hoursAgo(hours),
    status: "active",
    sourceSessionId: DOCK_SESSION_ID,
    ...(modality === "image" ? { filename: "architecture.png", contentType: "image/png" } : {}),
  } as never,
}));

function Harness() {
  const { events } = useSessionEvents(DOCK_SESSION_ID);
  const [collapsed, setCollapsed] = useState(startClosed);
  return (
    <div className="flex h-dvh flex-col bg-bg">
      <SessionHeader
        session={headerSession}
        ancestors={[]}
        connectionState="live"
        status="idle"
        keyAuthRequired={false}
        onForgetAccessKey={() => undefined}
        inspectorOpen={!collapsed}
        inspectorHint={withHint}
        onToggleInspector={() => setCollapsed((value) => !value)}
        onRename={async () => null}
        onPin={async () => null}
      />
      <div className="min-h-0 flex-1">
      <SandboxWorkspace
        sessionId={DOCK_SESSION_ID}
        events={events}
        autoSaveId={`og.session-dock.${withPr ? "pr" : "changes"}`}
        defaultSize={60}
        tabVisibility="relevant"
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        {...(withPr
          ? { initialTab: "pull-request" }
          : rememberedTab
            ? { initialTab: rememberedTab }
            : {})}
        {...(withPr
          ? { pullRequest: { url: PR_URL, number: 482 } }
          : { onOpenPullRequest: async () => {} })}
        primary={
          <section className="flex h-full flex-col justify-end p-6 text-sm text-fg-muted">
            <p className="max-w-md">
              Done. The CORS allowlist, helmet and rate limits are in, and monitoring is on.
            </p>
          </section>
        }
        trailingTabs={[
          {
            id: "artifacts",
            label: "Artifacts",
            icon: <PanelsTopLeftIcon />,
            ...(withArtifacts ? {} : { optional: true }),
            content: (
              <SessionEditableArtifactsWorkspace
                workspaceId={WORKSPACE_ID}
                sessionId={DOCK_SESSION_ID}
                artifacts={withArtifacts ? artifacts : []}
                status="ready"
                onRetry={() => {}}
              />
            ),
          },
        ]}
        {...(withPr
          ? {
              leadingTabs: [
                {
                  id: "pull-request",
                  label: "PR #482",
                  icon: <GitPullRequestIcon />,
                  content: (
                    <PullRequestView
                      link={link}
                      state={{ status: "ready", detail }}
                      onMerge={async () => {}}
                    />
                  ),
                },
              ],
            }
          : {})}
      />
      </div>
    </div>
  );
}

const headerSession = {
  id: DOCK_SESSION_ID,
  workspaceId: WORKSPACE_ID,
  initialMessage: "Harden the API",
  title: "Harden the API",
  titleSource: "user",
  parentSessionId: null,
  model: "codex/gpt-5.6-sol",
  reasoningEffort: "high",
  latencyMode: "standard",
  metadata: {},
  status: "idle",
  pinned: false,
  effectiveControl: {
    state: "active",
    directState: "active",
    primaryBlocker: null,
    additionalBlockerCount: 0,
  },
} as never;

function App() {
  const navigation = useMemoryNavigation({
    initialPath: `/workspaces/${WORKSPACE_ID}/sessions/${DOCK_SESSION_ID}`,
    consoleOrigin: window.location.origin,
    handles: () => true,
  });
  const context = useMemo(
    () =>
      ({
        client,
        accessContext: {
          mode: "managed",
          subjectId: "user:kari",
          workspaceGrants: [
            {
              workspaceId: WORKSPACE_ID,
              subjectId: "user:kari",
              principalKind: "human_session",
              permissions: ["sessions:read", "sessions:control", "artifacts:publish"],
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
        workspaceDefaultToolIds: [],
        toolMcpServers: [],
        workspaceCapabilityCatalog: [],
        captureWorkspaceInvocation: () => ({}),
        ownsWorkspaceInvocation: () => true,
      }) as never,
    [],
  );
  return (
    <OpenGeniProvider client={client as never} workspaceId={WORKSPACE_ID}>
      <AppHostProvider
        host={{ api: { apiBaseUrl: "https://app.opengeni.ai" } as never, navigation }}
      >
        <AppContext.Provider value={context}>
          <Harness />
        </AppContext.Provider>
      </AppHostProvider>
    </OpenGeniProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
