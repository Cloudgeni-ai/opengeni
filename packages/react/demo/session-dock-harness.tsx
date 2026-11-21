// The chat's side panel as the app shows it (relevant tabs only, "+" for the
// rest), with the app's stylesheet stack, to preview it with real components.
// A state-driven mock client answers the workbench reads; nothing reaches an
// API.
//   ?pr=1          the chat has a linked pull request (PR tab first)
//   ?state=<key>   a workbench dock state (default branch-review)
//   ?theme=light   light theme (default dark)
//   ?nav=<kind>    how Changes moves between files: rail, focus, stream, tree
import type { SessionLinkWithStatus, SessionPullRequestDetail } from "@opengeni/sdk";
import { GitPullRequestIcon } from "lucide-react";
import { createRoot } from "react-dom/client";
import { OpenGeniProvider, SandboxWorkspace, useSessionEvents } from "@opengeni/react";
import { enablePierreDiffs } from "@opengeni/react/diffs";
import { PullRequestView } from "@opengeni/react/app/components/session/pull-request-panel";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { DOCK_SESSION_ID, DOCK_STATES, DockStateMockClient } from "./workbench-dock-states";
import { enableWorkbenchDemoPeers } from "./workbench-peers";
import {
  WorkbenchChangesNavigationContext,
  type WorkbenchChangesNavigation,
} from "../src/components/workbench-changes-nav";
import "./agent-settings.css";

enableWorkbenchDemoPeers();
enablePierreDiffs({ worker: () => new DiffsWorker() });

const params = new URLSearchParams(window.location.search);
const withPr = params.get("pr") === "1";
const light = params.get("theme") === "light";
const nav = (params.get("nav") ?? undefined) as WorkbenchChangesNavigation | undefined;
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

function Harness() {
  const { events } = useSessionEvents(DOCK_SESSION_ID);
  return (
    <div className="h-dvh bg-bg">
      <SandboxWorkspace
        sessionId={DOCK_SESSION_ID}
        events={events}
        autoSaveId={`og.session-dock.${withPr ? "pr" : "changes"}`}
        defaultSize={60}
        tabVisibility="relevant"
        {...(withPr ? { initialTab: "pull-request" } : {})}
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
  );
}

createRoot(document.getElementById("root")!).render(
  <OpenGeniProvider client={client as never} workspaceId="11111111-2222-4333-8444-555555555555">
    <WorkbenchChangesNavigationContext.Provider value={nav}>
      <Harness />
    </WorkbenchChangesNavigationContext.Provider>
  </OpenGeniProvider>,
);
