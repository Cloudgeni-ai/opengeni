import { createHash } from "node:crypto";
import type postgres from "postgres";
import { createDb, createOrganizationApiKey, createSession, createWorkspace, ensureExternalIdentity } from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import { createObservability } from "@opengeni/observability";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { createApp } from "../../src/app";

/** Real production HTTP composition and restricted PostgreSQL, no model calls. */
export async function chatReadStack() {
  const shared = await acquireSharedTestDatabase("chat-read-cost");
  if (!shared) throw new Error("Chat read budgets require real PostgreSQL");
  const client = createDb(shared.appUrl);
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const statements: string[] = [];
  driver.options.debug = (_connection, query) => statements.push(query);
  const [account] = await shared.admin`insert into managed_accounts (name) values ('Embedded chat benchmark') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(client.db, { accountId, name: "Shared workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(client.db, {
    accountId, name: "Embedding key", prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:admin", "workspace:create", "members:manage", "api_keys:manage"],
  });
  const identity = await ensureExternalIdentity(client.db, { accountId, source: "benchmark", externalId: "reader" });
  const headers = {
    authorization: `Bearer ${token}`,
    "x-opengeni-external-actor": encodeURIComponent(JSON.stringify({
      mode: "external", identity: { source: "benchmark", externalId: "reader" },
      membership: { permissions: ["workspace:read", "sessions:create", "sessions:read", "sessions:control", "files:read", "files:upload", "mcp_servers:attach", "scheduled_tasks:run"] },
    })),
  };
  const settings = testSettings({ databaseUrl: shared.appUrl, productAccessMode: "managed", sandboxBackend: "none" });
  const deps = {
    db: client.db, settings, bus: new MemoryEventBus(), managedAuth: null,
    observability: createObservability(settings, { component: "api" }),
    workflowClient: {}, objectStorage: null, githubStateSecret: "test",
    documentIndexer: { indexDocument: async () => {} }, getDocumentServices: () => ({}),
  } as unknown as ApiRouteDeps;
  const app = createApp(deps);
  const base = `/v1/workspaces/${workspace.id}`;
  const admission = await app.request(`${base}/model-catalog`, { headers });
  if (admission.status !== 200) throw new Error(`Fixture admission: ${await admission.text()}`);
  const session = await createSession(client.db, {
    accountId, workspaceId: workspace.id, initialMessage: "Read benchmark", resources: [], metadata: {},
    model: "gpt-5", reasoningEffort: "medium", latencyMode: "standard", sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: identity.subjectId }, createdByContext: {},
  });
  const sessionBase = `${base}/sessions/${session.id}`;
  const paths = {
    "config/client": `/v1/config/client?workspaceId=${workspace.id}`,
    session: sessionBase,
    "composer-draft": `${sessionBase}/composer-draft`,
    "model-catalog": `${base}/model-catalog`,
    "realtime-model-catalog": `${base}/realtime-model-catalog`,
    events: `${sessionBase}/events`,
    recordings: `${base}/recordings?purpose=dictation`,
    queue: `${sessionBase}/queue`,
    "human-input-requests": `${sessionBase}/human-input-requests`,
    goal: `${sessionBase}/goal`,
    lineage: `${sessionBase}/lineage`,
    "events/stream": `${sessionBase}/events/stream`,
  };
  return {
    app, deps, shared, client, statements, paths, headers, workspace, session, identity,
    async close() { await client.close(); await shared.release(); },
  };
}
