import { expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";
import { siteAgentMayWrite, siteAgentWriteResource } from "../src/site-agent-guard";

const ID = "00000000-0000-4000-8000-000000000000";

/** Every write route under `/v1/workspaces/:workspaceId`, with every route-gating flag on. */
function workspaceWrites(): string[] {
  const settings = testSettings({
    authRequired: true,
    accessKey: "site-agent-guard",
    productAccessMode: "configured",
    integrationsEnabled: true,
    codexSubscriptionEnabled: true,
    supergrokSubscriptionEnabled: true,
    sandboxSelfhostedEnabled: true,
    sandboxDesktopEnabled: true,
    streamControlEnabled: true,
    mcpOauthEnabled: true,
    sitesDomain: "sites.example.test",
    sitesGatewaySecret: "c".repeat(40),
  });
  const observability = createObservability(settings, { component: "api" });
  observability.info = () => undefined;
  observability.warn = () => undefined;
  const app = createApp({
    settings,
    observability,
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  });
  const routes = new Set<string>();
  for (const route of app.routes) {
    // Middleware (`(c, next)`) is not a route.
    if (route.handler.length >= 2) continue;
    if (["GET", "HEAD", "OPTIONS"].includes(route.method)) continue;
    if (!/^\/v1\/workspaces\/:[A-Za-z]+(?:\/|$)/u.test(route.path)) continue;
    routes.add(`${route.method} ${route.path.replace(/^\/v1\/workspaces\/:[A-Za-z]+/u, "")}`);
  }
  return [...routes].sort();
}

function concrete(route: string): string {
  return `/v1/workspaces/${ID}${route.replace(/:[A-Za-z0-9_]+/gu, ID).replace(/\*$/u, "x")}`;
}

// A Site-started agent's writes are an allowlist: every route not listed here
// is refused to it, including routes added later. Opening one is a
// deliberate edit to SITE_AGENT_WRITES and to this list. (A Site's versions,
// rollback, status and audience are not here: the guard checks them against
// the Sites the agent was started from.)
const OPEN = [
  "ALL /codemode/sdk/*",
  "ALL /company-brain/knowledge/browse",
  "ALL /company-brain/knowledge/search",
  "ALL /mcp",
  "ALL /mcp/docs",
  "ALL /mcp/files",
  "DELETE /browser-sessions/:browserSessionId/targets/:targetId",
  "DELETE /published-artifacts/:artifactId/data/collections/:name",
  "DELETE /published-artifacts/:artifactId/files/:fileId",
  "DELETE /sessions/:sessionId",
  "DELETE /sessions/:sessionId/background-commands/:commandId",
  "DELETE /sessions/:sessionId/goal",
  "PATCH /sessions/:sessionId",
  "PATCH /sessions/:sessionId/goal",
  "POST /artifacts/:artifactId/playback-source",
  "POST /browser-sessions",
  "POST /browser-sessions/:browserSessionId/actions",
  "POST /browser-sessions/:browserSessionId/attachments",
  "POST /browser-sessions/:browserSessionId/auth-runs",
  "POST /browser-sessions/:browserSessionId/auth-runs/:authRunId/external-auth",
  "POST /browser-sessions/:browserSessionId/auth-runs/:authRunId/external-auth/interactive",
  "POST /browser-sessions/:browserSessionId/auth-runs/:authRunId/report",
  "POST /browser-sessions/:browserSessionId/auth-runs/:authRunId/verify",
  "POST /browser-sessions/:browserSessionId/downloads/:downloadId/save",
  "POST /browser-sessions/:browserSessionId/end",
  "POST /browser-sessions/:browserSessionId/heartbeat",
  "POST /browser-sessions/:browserSessionId/resume",
  "POST /browser-sessions/:browserSessionId/revisions",
  "POST /browser-sessions/:browserSessionId/suspend",
  "POST /browser-sessions/:browserSessionId/targets",
  "POST /browser-sessions/:browserSessionId/targets/:targetId/dom-read",
  "POST /browser-sessions/:browserSessionId/targets/:targetId/select",
  "POST /browser-sessions/:browserSessionId/targets/open-with-inventory",
  "POST /codemode/calls",
  "POST /computer-sessions",
  "POST /computer-sessions/:computerSessionId/actions",
  "POST /computer-sessions/:computerSessionId/attachments",
  "POST /computer-sessions/:computerSessionId/end",
  "POST /computer-sessions/:computerSessionId/heartbeat",
  "POST /computer-sessions/:computerSessionId/native-calls",
  "POST /document-bases/:baseId/search",
  "POST /documents/:documentId/original-file/download-url",
  "POST /editable-artifacts",
  "POST /editable-artifacts/:artifactId/live-ticket",
  "POST /editable-artifacts/:artifactId/materializations",
  "POST /editable-artifacts/:artifactId/versions",
  "POST /editable-artifacts/imports",
  "POST /feedback",
  "POST /files/:fileId/download-url",
  "POST /files/uploads",
  "POST /files/uploads/:uploadId/complete",
  "POST /knowledge/entries/:entryId/file/download-url",
  "POST /knowledge/entries/prepare-save",
  "POST /knowledge/entries/search",
  "POST /knowledge/search",
  "POST /machines/:enrollmentId/audience/preview",
  "POST /published-artifacts",
  "POST /published-artifacts/:artifactId/data/collections/:name/import",
  "POST /published-artifacts/:artifactId/data/collections/:name/reset",
  "POST /published-artifacts/:artifactId/data/get",
  "POST /published-artifacts/:artifactId/data/query",
  "POST /published-artifacts/:artifactId/data/write",
  "POST /published-artifacts/:artifactId/files",
  "POST /published-artifacts/uploads",
  "POST /sessions",
  "POST /sessions/:sessionId/artifacts/publish",
  "POST /sessions/:sessionId/composer-draft/submit",
  "POST /sessions/:sessionId/context/clear",
  "POST /sessions/:sessionId/context/compact",
  "POST /sessions/:sessionId/control",
  "POST /sessions/:sessionId/events",
  "POST /sessions/:sessionId/fs/delete",
  "POST /sessions/:sessionId/fs/list",
  "POST /sessions/:sessionId/fs/list-batch",
  "POST /sessions/:sessionId/fs/mkdir",
  "POST /sessions/:sessionId/fs/move",
  "POST /sessions/:sessionId/fs/read",
  "POST /sessions/:sessionId/fs/read-workspace",
  "POST /sessions/:sessionId/fs/write",
  "POST /sessions/:sessionId/git/diff",
  "POST /sessions/:sessionId/git/log",
  "POST /sessions/:sessionId/git/read-batch",
  "POST /sessions/:sessionId/git/show",
  "POST /sessions/:sessionId/git/status",
  "POST /sessions/:sessionId/goal/revisions/:revisionId/apply",
  "POST /sessions/:sessionId/goal/revisions/:revisionId/reject",
  "POST /sessions/:sessionId/goal/revisions/:revisionId/rollback",
  "POST /sessions/:sessionId/queue/:turnId/delete",
  "POST /sessions/:sessionId/queue/:turnId/edit",
  "POST /sessions/:sessionId/queue/:turnId/move",
  "POST /sessions/:sessionId/queue/:turnId/steer",
  "POST /sessions/:sessionId/retry",
  "POST /sessions/:sessionId/steer",
  "POST /sessions/:sessionId/terminal/exec",
  "POST /sessions/:sessionId/terminal/pty",
  "POST /sessions/:sessionId/terminal/pty/close",
  "POST /sessions/:sessionId/terminal/pty/resize",
  "POST /sessions/:sessionId/terminal/pty/write",
  "POST /tools/calls",
  "POST /tools/invoke",
  "POST /tools/manifest",
  "POST /tools/resolve",
  "PUT /published-artifacts/:artifactId/data/collections/:name",
  "PUT /sessions/:sessionId/archive",
  "PUT /sessions/:sessionId/composer-draft",
];

test("a Site-started agent's writes are exactly the allowlist; every other workspace write is closed", () => {
  const writes = workspaceWrites();
  // The inventory is the real route table, not an empty one.
  expect(writes.length).toBeGreaterThan(300);
  const open = writes.filter((route) => siteAgentMayWrite(concrete(route.split(" ")[1]!)));
  expect(open).toEqual(OPEN);
  // Families the earlier block list did not name are closed.
  for (const family of [
    "variable-sets",
    "environments",
    "model-providers",
    "gateway-custom-models",
    "openrouter-custom-models",
    "opper-custom-models",
    "github",
    "identity-links",
    "claude",
    "codex",
    "supergrok",
    "company-brain/knowledge/record",
    "channels",
    "slack-task-policy",
    "preferences",
    "user-resource-authorities",
    "memory-slack-publications",
    "tools/approvals",
    "tools/target-approvals",
    "chat/completions",
  ]) {
    const closed = writes.filter((route) => route.split(" ")[1]!.startsWith(`/${family}`));
    expect({ family, routes: closed.length > 0 }).toEqual({ family, routes: true });
    expect({ family, open: closed.filter((route) => OPEN.includes(route)) }).toEqual({
      family,
      open: [],
    });
  }
});

test("paths outside the allowlist are closed, matched as the router decodes them", () => {
  const ws = `/v1/workspaces/${ID}`;
  for (const path of [
    ws,
    `${ws}/`,
    `${ws}/a-family-added-later`,
    `${ws}/mcp/servers`,
    `${ws}/sessions/${ID}/tool-policy`,
    `${ws}/sessions/${ID}/vault-policy`,
    `${ws}/sessions/${ID}/variable-sets`,
    `${ws}/sessions/${ID}/usage-limit`,
    `${ws}/sessions/${ID}/admin-access`,
    `${ws}/sessions/${ID}/active-sandbox`,
    `${ws}/sessions/${ID}/forks`,
    `${ws}/sessions/${ID}/../settings`,
    `${ws}/published-artifacts/${ID}/publication`,
    `${ws}/published-artifacts/${ID}/versions`,
    `${ws}/knowledge/entries`,
    `${ws}/files/${ID}`,
  ])
    expect({ path, open: siteAgentMayWrite(path) }).toEqual({ path, open: false });
  expect(siteAgentMayWrite(`${ws}/sessions/${ID}/events`)).toBe(true);
  expect(siteAgentMayWrite(`${ws}/mcp`)).toBe(true);
});

test("a refusal names what the write would change", () => {
  const ws = `/v1/workspaces/${ID}`;
  expect(siteAgentWriteResource(ws)).toBe("workspace members, connections or settings");
  expect(siteAgentWriteResource(`${ws}/variable-sets`)).toBe("secrets");
  expect(siteAgentWriteResource(`${ws}/environments/x`)).toBe("sandbox environments");
  expect(siteAgentWriteResource(`${ws}/github/installations`)).toBe(
    "workspace members, connections or settings",
  );
  expect(siteAgentWriteResource(`${ws}/scheduled-tasks`)).toBe("schedules");
  expect(siteAgentWriteResource(`${ws}/published-artifacts/${ID}/publication`)).toBe(
    "Site publications",
  );
  expect(siteAgentWriteResource(`${ws}/site-limit-profile`)).toBe("Site publications");
  expect(siteAgentWriteResource(`${ws}/model-providers/openai/custom-models`)).toBe(
    "workspace settings",
  );
  expect(siteAgentWriteResource(`${ws}/sessions/${ID}/tool-policy`)).toBe("workspace settings");
});
