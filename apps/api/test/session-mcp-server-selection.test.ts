import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createDb, type Database, type DbClient } from "@opengeni/db";
import type { AccessGrant } from "@opengeni/contracts";
import {
  createSessionForRequest,
  withSameRequestSessionMcpServerTools,
  type ApiRouteDeps,
  type SessionWorkflowClient,
} from "@opengeni/core";

// A server attached in the same top-level create request is selected by that
// attachment. Before this, `mcpServers` without a matching `tools` ref was
// persisted but never contacted, so the model silently had no tools.

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

const settings = testSettings({
  sandboxBackend: "none",
  environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
});

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id };
}

function deps(): ApiRouteDeps {
  const noop = async () => {};
  return {
    settings,
    db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
    } as unknown as SessionWorkflowClient,
    githubStateSecret: "x",
    objectStorage: null,
  } as unknown as ApiRouteDeps;
}

function grant(accountId: string, workspaceId: string): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId: "service:embedding-host",
    permissions: ["sessions:create", "sessions:read", "mcp_servers:attach"],
  };
}

const umami = {
  id: "umami",
  url: "https://mcp.example.test/umami",
  headers: { Authorization: "Bearer synthetic" },
};

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-mcp-server-selection");
  if (!shared) {
    available = false;
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("withSameRequestSessionMcpServerTools", () => {
  test("adds a strict ref for an unselected attached server", () => {
    expect(withSameRequestSessionMcpServerTools([], [{ id: "umami" }])).toEqual([
      { kind: "mcp", id: "umami" },
    ]);
  });

  test("keeps an explicit ref's markers instead of merging them to strict", () => {
    const explicit = [{ kind: "mcp" as const, id: "umami", optional: true, eager: true }];
    expect(withSameRequestSessionMcpServerTools(explicit, [{ id: "umami" }])).toBe(explicit);
  });
});

describe("createSessionForRequest selects same-request mcpServers", () => {
  test("explicit tools: [] still selects the attached server", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const session = await createSessionForRequest(
      deps(),
      grant(accountId, workspaceId),
      workspaceId,
      { initialMessage: "hi", mcpServers: [umami], tools: [] },
    );
    expect(session.toolPolicy.mode).toBe("explicit");
    expect(session.tools).toContainEqual({ kind: "mcp", id: "umami" });
  }, 60_000);

  test("omitted tools selects the attached server on top of workspace defaults", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const session = await createSessionForRequest(
      deps(),
      grant(accountId, workspaceId),
      workspaceId,
      { initialMessage: "hi", mcpServers: [umami] },
    );
    expect(session.toolPolicy.mode).toBe("workspace_default");
    expect(session.tools).toContainEqual({ kind: "mcp", id: "umami" });
  }, 60_000);

  test("an explicit eager ref is preserved exactly", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const session = await createSessionForRequest(
      deps(),
      grant(accountId, workspaceId),
      workspaceId,
      {
        initialMessage: "hi",
        mcpServers: [umami],
        tools: [{ kind: "mcp", id: "umami", eager: true }],
      },
    );
    expect(session.tools.filter((tool) => tool.id === "umami")).toEqual([
      { kind: "mcp", id: "umami", eager: true },
    ]);
  }, 60_000);
});
