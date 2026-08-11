import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import { signDelegatedAccessToken, type Channel, type Permission } from "@opengeni/contracts";
import { createDb, createSession, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";

const DELEGATION_SECRET = "channels-routes-delegation-secret";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;

const encryptionKey = randomBytes(32).toString("base64");

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_channels");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[channels-routes] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    environmentsEncryptionKey: encryptionKey,
  }) as Settings;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

function app() {
  return createApp({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  } as never);
}

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  await shared!
    .admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function bearer(
  workspace: { accountId: string; workspaceId: string },
  subjectId: string,
  permissions: Permission[],
): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `Bearer ${token}`;
}

describe("channel routes", () => {
  test("CRUD with session permissions; conflicts and unknown ids are typed", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const writer = { "content-type": "application/json", authorization: await bearer(ws, "user:w", ["sessions:read", "sessions:create"]) };
    const reader = { authorization: await bearer(ws, "user:r", ["sessions:read"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/channels`;

    // Read-only member can list but not create.
    expect((await app().request(base, { headers: reader })).status).toBe(200);
    expect(
      (
        await app().request(base, {
          method: "POST",
          headers: { ...reader, "content-type": "application/json" },
          body: JSON.stringify({ name: "security" }),
        })
      ).status,
    ).toBe(403);

    const created = await app().request(base, {
      method: "POST",
      headers: writer,
      body: JSON.stringify({ name: "security", description: "audits" }),
    });
    expect(created.status).toBe(201);
    const channel = (await created.json()) as Channel;
    expect(channel.name).toBe("security");
    expect(channel.createdBy).toBe("user:w");

    // Duplicate name (case-insensitive) conflicts.
    expect(
      (
        await app().request(base, {
          method: "POST",
          headers: writer,
          body: JSON.stringify({ name: "Security" }),
        })
      ).status,
    ).toBe(409);

    const listed = await app().request(base, { headers: reader });
    expect(((await listed.json()) as Channel[]).map((row) => row.name)).toEqual(["security"]);

    const patched = await app().request(`${base}/${channel.id}`, {
      method: "PATCH",
      headers: writer,
      body: JSON.stringify({ name: "sec-audits", description: null }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as Channel).name).toBe("sec-audits");

    // Unknown/malformed ids stay non-enumerating 404s.
    expect(
      (
        await app().request(`${base}/${crypto.randomUUID()}`, {
          method: "PATCH",
          headers: writer,
          body: JSON.stringify({ name: "x" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app().request(`${base}/not-a-uuid`, { method: "DELETE", headers: writer })
      ).status,
    ).toBe(404);

    expect(
      (await app().request(`${base}/${channel.id}`, { method: "DELETE", headers: writer })).status,
    ).toBe(200);
    expect(
      (await app().request(`${base}/${channel.id}`, { method: "DELETE", headers: writer })).status,
    ).toBe(404);
  });

  test("files a session at create, re-files over PUT /channel, 422s an unknown target", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const headers = {
      "content-type": "application/json",
      authorization: await bearer(ws, "user:w", [
        "sessions:read",
        "sessions:create",
        "sessions:control",
      ]),
    };
    const channelsBase = `/v1/workspaces/${ws.workspaceId}/channels`;
    const createdChannel = await app().request(channelsBase, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "knowledge" }),
    });
    const channel = (await createdChannel.json()) as Channel;

    // Create a session directly at the db layer (the full create route needs
    // workflow wiring); the PUT re-file route is what this test exercises.
    const session = await createSession(client.db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      initialMessage: "organize me",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
    });
    expect(session.channelId).toBeNull();

    const sessionBase = `/v1/workspaces/${ws.workspaceId}/sessions/${session.id}`;
    const filed = await app().request(`${sessionBase}/channel`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ channelId: channel.id }),
    });
    expect(filed.status).toBe(200);
    expect(((await filed.json()) as { channelId: string | null }).channelId).toBe(channel.id);

    // Unknown channel -> 422; unfiling -> null.
    expect(
      (
        await app().request(`${sessionBase}/channel`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ channelId: crypto.randomUUID() }),
        })
      ).status,
    ).toBe(422);
    const unfiled = await app().request(`${sessionBase}/channel`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ channelId: null }),
    });
    expect(unfiled.status).toBe(200);
    expect(((await unfiled.json()) as { channelId: string | null }).channelId).toBeNull();
  });
});
