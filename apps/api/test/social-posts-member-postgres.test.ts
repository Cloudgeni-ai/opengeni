import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Permission } from "@opengeni/contracts";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { createDb, createSocialConnection, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import { registerSocialRoutes } from "../src/routes/social";

// Recording a social post (real PostgreSQL): a member records posts on their
// own account; a workspace-owned account stays a workspace setting.

const DELEGATION_SECRET = "social-posts-member-test-secret-at-least-32-bytes";

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let app: Hono;

type Workspace = { accountId: string; workspaceId: string };

async function freshWorkspace(name: string): Promise<Workspace> {
  const admin = shared!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${name}) returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, ${name}) returning id`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function bearer(
  workspace: Workspace,
  subjectId: string,
  permissions: Permission[],
): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    ...workspace,
    subjectId,
    subjectLabel: subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  return `Bearer ${token}`;
}

async function post(auth: string, workspace: Workspace, connectionId: string) {
  const response = await app.request(
    `http://x/v1/workspaces/${workspace.workspaceId}/social/posts`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify({
        connectionId,
        text: "Shipped today",
        publishedAt: new Date().toISOString(),
      }),
    },
  );
  return { status: response.status, text: await response.text() };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-social-posts-member");
  if (!shared) return;
  client = createDb(shared.appUrl);
  app = new Hono();
  registerSocialRoutes(app, {
    db: client.db,
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "managed",
      delegationSecret: DELEGATION_SECRET,
    }),
  } as unknown as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("recording social posts", () => {
  test("members record posts on their own account, not on the workspace's", async () => {
    if (!shared) return;
    const workspace = await freshWorkspace("social posts member");
    const member = [
      "workspace:read",
      "sessions:create",
      "connections:read",
      "connections:write",
    ] as Permission[];
    const alice = await bearer(workspace, "user:alice", member);
    const bob = await bearer(workspace, "user:bob", member);
    const reader = await bearer(workspace, "user:reader", ["workspace:read"]);
    const admin = await bearer(workspace, "user:admin", ["workspace:admin"]);

    const own = await createSocialConnection(client.db, {
      ...workspace,
      subjectId: "user:alice",
      provider: "x",
      accountHandle: `alice-${crypto.randomUUID()}`,
      status: "active",
    });
    const team = await createSocialConnection(client.db, {
      ...workspace,
      subjectId: null,
      provider: "x",
      accountHandle: `team-${crypto.randomUUID()}`,
      status: "active",
    });
    expect(own.ownership).toBe("personal");
    expect(team.ownership).toBe("workspace");

    // Alice records a post on her own account.
    expect((await post(alice, workspace, own.id)).status).toBe(201);
    // Bob can't see Alice's account, let alone post on it.
    expect((await post(bob, workspace, own.id)).status).toBe(404);
    // Without connections:write nothing is recorded.
    expect((await post(reader, workspace, own.id)).status).toBe(403);
    // The workspace's own account is a workspace setting.
    const refused = await post(alice, workspace, team.id);
    expect(refused.status).toBe(403);
    expect(refused.text).toContain("Only a workspace admin");
    expect((await post(admin, workspace, team.id)).status).toBe(201);
  }, 120_000);
});
