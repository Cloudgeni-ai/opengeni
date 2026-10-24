import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  signDelegatedAccessToken,
  type AgentProfile,
  type Permission,
  type Session,
} from "@opengeni/contracts";
import { createDb, createSession, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

const DELEGATION_SECRET = "agent-profiles-routes-delegation-secret";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let enabledSettings: Settings;
let disabledSettings: Settings;

const encryptionKey = randomBytes(32).toString("base64");
const owl = { kind: "emoji", emoji: "🦉", hue: 235 } as const;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_agent_profiles");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[agent-profiles-routes] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  const base = {
    productAccessMode: "managed" as const,
    delegationSecret: DELEGATION_SECRET,
    environmentsEncryptionKey: encryptionKey,
  };
  enabledSettings = testSettings({ ...base, agentProfilesEnabled: true }) as Settings;
  disabledSettings = testSettings(base) as Settings;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

function app(settings: Settings = enabledSettings) {
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

describe("agent profile routes", () => {
  test("every route is invisible while the flag is off", async () => {
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
    const base = `/v1/workspaces/${ws.workspaceId}/agent-profiles`;
    const off = app(disabledSettings);
    expect((await off.request(base, { headers })).status).toBe(404);
    expect(
      (
        await off.request(base, {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "Annie", avatar: owl }),
        })
      ).status,
    ).toBe(404);
    const config = (await (await off.request("/v1/config/client")).json()) as {
      agentProfiles?: { enabled: boolean };
    };
    expect(config.agentProfiles).toEqual({ enabled: false });
    const on = (await (await app().request("/v1/config/client")).json()) as {
      agentProfiles?: { enabled: boolean };
    };
    expect(on.agentProfiles).toEqual({ enabled: true });
  });

  test("CRUD with session permissions, versioning, archive and restore", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const writer = {
      "content-type": "application/json",
      authorization: await bearer(ws, "user:w", ["sessions:read", "sessions:create"]),
    };
    const reader = { authorization: await bearer(ws, "user:r", ["sessions:read"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/agent-profiles`;

    expect((await app().request(base, { headers: reader })).status).toBe(200);
    expect(
      (
        await app().request(base, {
          method: "POST",
          headers: { ...reader, "content-type": "application/json" },
          body: JSON.stringify({ name: "Annie", avatar: owl }),
        })
      ).status,
    ).toBe(403);

    const created = await app().request(base, {
      method: "POST",
      headers: writer,
      body: JSON.stringify({
        name: "Annie",
        role: "PR reviewer",
        avatar: owl,
        config: { agent: { instructions: "Review pull requests." }, reasoningEffort: "high" },
      }),
    });
    expect(created.status).toBe(201);
    const profile = (await created.json()) as AgentProfile;
    expect(profile).toMatchObject({ name: "Annie", version: 1, createdBy: "user:w" });

    // An avatar must be one emoji.
    expect(
      (
        await app().request(base, {
          method: "POST",
          headers: writer,
          body: JSON.stringify({ name: "Two", avatar: { kind: "emoji", emoji: "🦉🐞", hue: 1 } }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app().request(base, {
          method: "POST",
          headers: writer,
          body: JSON.stringify({ name: "annie", avatar: owl }),
        })
      ).status,
    ).toBe(409);

    const patched = await app().request(`${base}/${profile.id}`, {
      method: "PATCH",
      headers: writer,
      body: JSON.stringify({ expectedVersion: 1, role: "Reviews every PR" }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as AgentProfile).version).toBe(2);
    expect(
      (
        await app().request(`${base}/${profile.id}`, {
          method: "PATCH",
          headers: writer,
          body: JSON.stringify({ expectedVersion: 1, role: "stale" }),
        })
      ).status,
    ).toBe(409);

    const versions = (await (
      await app().request(`${base}/${profile.id}/versions`, { headers: reader })
    ).json()) as { versions: Array<{ version: number }> };
    expect(versions.versions.map((version) => version.version)).toEqual([2, 1]);

    const archived = await app().request(`${base}/${profile.id}/archive`, {
      method: "POST",
      headers: writer,
    });
    expect(((await archived.json()) as AgentProfile).status).toBe("archived");
    const listed = (await (await app().request(base, { headers: reader })).json()) as {
      profiles: AgentProfile[];
    };
    expect(listed.profiles).toEqual([]);
    const all = (await (await app().request(`${base}?status=all`, { headers: reader })).json()) as {
      profiles: AgentProfile[];
    };
    expect(all.profiles.map((entry) => entry.id)).toEqual([profile.id]);
    const restored = await app().request(`${base}/${profile.id}/restore`, {
      method: "POST",
      headers: writer,
    });
    expect(((await restored.json()) as AgentProfile).status).toBe("active");

    expect((await app().request(`${base}/not-a-uuid`, { headers: reader })).status).toBe(404);
  });

  test("names only a chat's agent, then clears it", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const session = await createSession(client.db, {
      ...ws,
      initialMessage: "watch the rollout",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
    });
    const controller = {
      "content-type": "application/json",
      authorization: await bearer(ws, "user:w", ["sessions:read", "sessions:control"]),
    };
    const path = `/v1/workspaces/${ws.workspaceId}/sessions/${session.id}/agent-identity`;
    const named = await app().request(path, {
      method: "PUT",
      headers: controller,
      body: JSON.stringify({
        identity: { name: "Deploy watcher", avatar: { kind: "icon", icon: "rocket", hue: 260 } },
      }),
    });
    expect(named.status).toBe(200);
    expect(((await named.json()) as Session).agentProfile).toEqual({
      profileId: null,
      profileVersion: null,
      name: "Deploy watcher",
      role: null,
      avatar: { kind: "icon", icon: "rocket", hue: 260 },
    });
    const cleared = await app().request(path, {
      method: "PUT",
      headers: controller,
      body: JSON.stringify({ identity: null }),
    });
    expect(((await cleared.json()) as Session).agentProfile).toBeUndefined();
    expect(
      (
        await app(disabledSettings).request(path, {
          method: "PUT",
          headers: controller,
          body: JSON.stringify({ identity: null }),
        })
      ).status,
    ).toBe(404);
  });
});
