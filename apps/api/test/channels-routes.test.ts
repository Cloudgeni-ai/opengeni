import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import { signDelegatedAccessToken, type Channel, type Permission } from "@opengeni/contracts";
import { createDb, createSession, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
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
  principalKind: "human_session" | "service" = "human_session",
): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId,
    permissions,
    principalKind,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `Bearer ${token}`;
}

/** A shared workspace with two members of its organization, each with a Personal workspace. */
async function teamWorkspace() {
  const ws = await freshWorkspace();
  const owner = `user:${crypto.randomUUID()}`;
  const colleague = `user:${crypto.randomUUID()}`;
  const personal = [crypto.randomUUID(), crypto.randomUUID()] as const;
  for (const id of personal)
    await shared!
      .admin`insert into workspaces(id,account_id,name) values(${id},${ws.accountId},'Personal')`;
  await shared!
    .admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
    values(${ws.accountId},${owner},'member','active',${personal[0]}),
      (${ws.accountId},${colleague},'member','active',${personal[1]})`;
  await shared!
    .admin`insert into workspace_memberships(account_id,workspace_id,subject_id,role,permissions)
    values(${ws.accountId},${ws.workspaceId},${owner},'member',
        opengeni_private.workspace_member_role_permissions('member')),
      (${ws.accountId},${ws.workspaceId},${colleague},'member',
        opengeni_private.workspace_member_role_permissions('member'))`;
  // The organization allows Only me work in its shared workspaces.
  await shared!
    .admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${ws.accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'channels-routes-test')`;
  await shared!
    .admin`insert into organization_private_session_settings (account_id, enabled, version, updated_by_membership_id)
    values (${ws.accountId}, true, 1, null) on conflict (account_id) do update set enabled = true`;
  return { ...ws, owner, colleague };
}

describe("channel routes", () => {
  test("CRUD with session permissions; conflicts and unknown ids are typed", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const writer = {
      "content-type": "application/json",
      authorization: await bearer(ws, "user:w", ["sessions:read", "sessions:create"]),
    };
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

    const secondCreated = await app().request(base, {
      method: "POST",
      headers: writer,
      body: JSON.stringify({ name: "product" }),
    });
    expect(secondCreated.status).toBe(201);
    const secondChannel = (await secondCreated.json()) as Channel;
    const reordered = await app().request(`${base}/order`, {
      method: "PUT",
      headers: writer,
      body: JSON.stringify({ channelIds: [secondChannel.id, channel.id] }),
    });
    expect(reordered.status).toBe(200);
    expect(((await reordered.json()) as Channel[]).map((row) => row.id)).toEqual([
      secondChannel.id,
      channel.id,
    ]);

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
      (await app().request(`${base}/not-a-uuid`, { method: "DELETE", headers: writer })).status,
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
      reasoningEffort: "medium",
      latencyMode: "standard",
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

  test("a project's profile: avatar and description round-trip under rename's permission", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const writer = {
      "content-type": "application/json",
      authorization: await bearer(ws, "user:w", ["sessions:read", "sessions:create"]),
    };
    const reader = {
      "content-type": "application/json",
      authorization: await bearer(ws, "user:r", ["sessions:read"]),
    };
    const base = `/v1/workspaces/${ws.workspaceId}/channels`;
    const created = await app().request(base, {
      method: "POST",
      headers: writer,
      body: JSON.stringify({
        name: "Design",
        description: "Interface polish",
        avatar: { kind: "emoji", emoji: "🎨", hue: 275 },
      }),
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as Channel;
    expect(project.avatar).toEqual({ kind: "emoji", emoji: "🎨", hue: 275 });
    expect(project.description).toBe("Interface polish");

    // A project without an avatar reads back as null, not missing.
    const plain = (await (
      await app().request(base, {
        method: "POST",
        headers: writer,
        body: JSON.stringify({ name: "Plain" }),
      })
    ).json()) as Channel;
    expect(plain.avatar).toBeNull();

    // Read-only members can't change the profile, exactly like a rename.
    expect(
      (
        await app().request(`${base}/${project.id}`, {
          method: "PATCH",
          headers: reader,
          body: JSON.stringify({ avatar: { kind: "icon", icon: "rocket", hue: 215 } }),
        })
      ).status,
    ).toBe(403);

    // An avatar alone changes only the avatar.
    const iconed = await app().request(`${base}/${project.id}`, {
      method: "PATCH",
      headers: writer,
      body: JSON.stringify({ avatar: { kind: "icon", icon: "rocket", hue: 215 } }),
    });
    expect(iconed.status).toBe(200);
    const iconedBody = (await iconed.json()) as Channel;
    expect(iconedBody.avatar).toEqual({ kind: "icon", icon: "rocket", hue: 215 });
    expect(iconedBody.name).toBe("Design");
    expect(iconedBody.description).toBe("Interface polish");

    // Malformed avatars and images that aren't in the workspace are refused.
    expect(
      (
        await app().request(`${base}/${project.id}`, {
          method: "PATCH",
          headers: writer,
          body: JSON.stringify({ avatar: { kind: "icon", icon: "not-an-icon", hue: 1 } }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app().request(`${base}/${project.id}`, {
          method: "PATCH",
          headers: writer,
          body: JSON.stringify({ avatar: { kind: "image", artifactId: crypto.randomUUID() } }),
        })
      ).status,
    ).toBe(422);

    // Everyone in the workspace sees a project, so an Only me image is
    // refused even for its owner (a person's request can't open it here at
    // all; projects-mcp covers the "Only me" refusal), and a shared image is
    // accepted.
    const image = async (privateTo: string | null) => {
      const id = crypto.randomUUID();
      await shared!
        .admin`insert into files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,sha256,bucket,object_key,private_owner_subject_ids,owner_subject_id)
        values(${id},${ws.accountId},${ws.workspaceId},'ready','logo.png','logo.png','image/png',4,${"a".repeat(64)},'fixture',
          ${`workspaces/${ws.workspaceId}/files/${id}/logo.png`},${privateTo ? [privateTo] : null},${privateTo})`;
      return id;
    };
    const onlyMe = await app().request(`${base}/${project.id}`, {
      method: "PATCH",
      headers: writer,
      body: JSON.stringify({ avatar: { kind: "image", artifactId: await image("user:w") } }),
    });
    expect(onlyMe.status).toBe(422);
    const sharedImage = await image(null);
    const pictured = await app().request(`${base}/${project.id}`, {
      method: "PATCH",
      headers: writer,
      body: JSON.stringify({ avatar: { kind: "image", artifactId: sharedImage } }),
    });
    expect(pictured.status).toBe(200);
    expect(((await pictured.json()) as Channel).avatar).toEqual({
      kind: "image",
      artifactId: sharedImage,
    });

    // Clearing the avatar brings back the folder; the list carries it too.
    const cleared = await app().request(`${base}/${project.id}`, {
      method: "PATCH",
      headers: writer,
      body: JSON.stringify({ avatar: null }),
    });
    expect(((await cleared.json()) as Channel).avatar).toBeNull();
    await app().request(`${base}/${project.id}`, {
      method: "PATCH",
      headers: writer,
      body: JSON.stringify({ avatar: { kind: "letters", letters: "UX", hue: 0 } }),
    });
    const listed = (await (await app().request(base, { headers: reader })).json()) as Channel[];
    expect(listed.find((row) => row.id === project.id)?.avatar).toEqual({
      kind: "letters",
      letters: "UX",
      hue: 0,
    });
  });

  test("a project is shared or Only me; only its owner, signed in, shares it", async () => {
    if (!available) return;
    const ws = await teamWorkspace();
    const permissions: Permission[] = ["sessions:read", "sessions:create", "sessions:control"];
    const owner = {
      "content-type": "application/json",
      authorization: await bearer(ws, ws.owner, permissions),
    };
    const colleague = {
      "content-type": "application/json",
      authorization: await bearer(ws, ws.colleague, permissions),
    };
    const base = `/v1/workspaces/${ws.workspaceId}/channels`;
    const create = async (headers: Record<string, string>, body: Record<string, unknown>) =>
      await app().request(base, { method: "POST", headers, body: JSON.stringify(body) });
    const names = async (headers: Record<string, string>) =>
      ((await (await app().request(base, { headers })).json()) as Channel[]).map(
        (row) => `${row.name}:${row.visibility}`,
      );

    // Omitted, a person's project is shared, as every project was before.
    const team = await create(owner, { name: "Team" });
    expect(team.status).toBe(201);
    const teamProject = (await team.json()) as Channel;
    expect(teamProject.visibility).toBe("workspace");

    const mineCreated = await create(owner, { name: "Plans", visibility: "private" });
    expect(mineCreated.status).toBe(201);
    const mine = (await mineCreated.json()) as Channel;
    expect(mine.visibility).toBe("private");

    // Only its owner sees it; its name neither blocks nor reaches anyone else.
    expect(await names(owner)).toEqual(["Team:workspace", "Plans:private"]);
    expect(await names(colleague)).toEqual(["Team:workspace"]);
    expect((await create(colleague, { name: "plans" })).status).toBe(201);
    expect((await create(owner, { name: "Plans", visibility: "private" })).status).toBe(409);
    expect(
      (
        await app().request(`${base}/${mine.id}`, {
          method: "PATCH",
          headers: colleague,
          body: JSON.stringify({ name: "Taken over" }),
        })
      ).status,
    ).toBe(404);

    // A shared chat doesn't fit an Only me project.
    const sharedChat = await createSession(client.db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      initialMessage: "shared work",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const filed = await app().request(
      `/v1/workspaces/${ws.workspaceId}/sessions/${sharedChat.id}/channel`,
      { method: "PUT", headers: owner, body: JSON.stringify({ channelId: mine.id }) },
    );
    expect(filed.status).toBe(422);
    expect(await filed.text()).toContain("An Only me project holds only your own Only me chats.");

    // Sharing is the owner's own decision in the app; it never narrows.
    const share = (headers: Record<string, string>, visibility: string, id = mine.id) =>
      app().request(`${base}/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ visibility }),
      });
    const service = {
      "content-type": "application/json",
      authorization: await bearer(ws, ws.owner, permissions, "service"),
    };
    expect((await share(service, "workspace")).status).toBe(403);
    expect((await share(owner, "private", teamProject.id)).status).toBe(400);
    // The colleague's shared "plans" holds the name among shared projects.
    expect((await share(owner, "workspace")).status).toBe(409);
    const renamed = await app().request(`${base}/${mine.id}`, {
      method: "PATCH",
      headers: owner,
      body: JSON.stringify({ name: "Plans 2026", visibility: "workspace" }),
    });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as Channel).visibility).toBe("workspace");
    expect(await names(colleague)).toContain("Plans 2026:workspace");
  });
});
