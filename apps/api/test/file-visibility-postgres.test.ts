import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ObjectStorageDependency, SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createWorkspace,
  ensureExternalIdentity,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";

// A file has the same two audiences as a Site: Only me or the workspace.
// These run the real file routes against PostgreSQL as the restricted
// application role, so row-level security decides what each person sees.
let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("file-visibility");
  if (!acquired) throw new Error("File visibility tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

const noop = async () => undefined;
const memberPermissions = ["workspace:read", "files:read", "files:upload"] as const;

async function fixture() {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('File visibility fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(db.db, { accountId, name: "Team workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(db.db, {
    accountId,
    name: "Service fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [
      "workspace:read",
      "workspace:admin",
      "members:manage",
      "files:read",
      "files:upload",
      "account:admin",
    ],
  });
  const app = createApp({
    db: db.db,
    bus: new MemoryEventBus(),
    settings: testSettings({ productAccessMode: "configured", sandboxBackend: "none" }),
    objectStorage: {
      bucket: "fixture",
      maxSinglePutSizeBytes: 5_000_000_000,
      createPutUrl: async (input: { key: string }) => ({
        url: `https://storage.example.test/${input.key}`,
        expiresAt: new Date(Date.now() + 60_000),
        requiredHeaders: {},
      }),
    } as unknown as ObjectStorageDependency,
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
    } as unknown as SessionWorkflowClient,
    managedAuth: null,
  } as unknown as AppDependencies);
  const source = "example:instance";
  const service = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const person = async () => {
    const identity = await ensureExternalIdentity(db.db, {
      accountId,
      source,
      externalId: crypto.randomUUID(),
    });
    const added = await app.request(`/v1/workspaces/${workspace.id}/external-members`, {
      method: "POST",
      headers: service,
      body: JSON.stringify({
        identity: { source, externalId: identity.externalId },
        permissions: memberPermissions,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(added.status).toBe(200);
    return {
      subjectId: identity.subjectId,
      headers: {
        ...service,
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({
            mode: "external",
            identity: { source, externalId: identity.externalId },
          }),
        ),
      },
    };
  };
  const owner = await person();
  const other = await person();
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'file-visibility-test')`;
  await shared.admin`insert into organization_private_session_settings (account_id, enabled, version, updated_by_membership_id)
    values (${accountId}, true, 1, null) on conflict (account_id) do update set enabled = true`;
  const call = (
    who: { headers: Record<string, string> },
    method: string,
    path: string,
    body?: unknown,
  ) =>
    app.request(`/v1/workspaces/${workspace.id}${path}`, {
      method,
      headers: who.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const readyFile = async (privateTo: string | null) => {
    const id = crypto.randomUUID();
    await shared.admin`insert into files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,sha256,bucket,object_key,private_owner_subject_ids,owner_subject_id)
      values(${id},${accountId},${workspace.id},'ready','chart.png','chart.png','image/png',4,${"a".repeat(64)},'fixture',
        ${`workspaces/${workspace.id}/files/${id}/chart.png`},${privateTo ? [privateTo] : null},${privateTo})`;
    return id;
  };
  return { workspace, owner, other, call, readyFile };
}

test("someone else's Only me file says it is private, until its owner shares it", async () => {
  const f = await fixture();
  const fileId = await f.readyFile(f.owner.subjectId);
  const missing = crypto.randomUUID();

  // Another member learns only that it is private; a missing file stays 404.
  for (const suffix of ["", "/content"]) {
    const denied = await f.call(f.other, "GET", `/artifacts/${fileId}${suffix}`);
    expect({ suffix, status: denied.status }).toEqual({ suffix, status: 403 });
    const body = (await denied.json()) as Record<string, unknown>;
    expect(body).toEqual({ artifactId: fileId, available: false, reason: "private" });
    expect(JSON.stringify(body)).not.toContain("chart.png");
    expect(JSON.stringify(body)).not.toContain(f.owner.subjectId);
    const absent = await f.call(f.other, "GET", `/artifacts/${missing}${suffix}`);
    expect({ suffix, status: absent.status }).toEqual({ suffix, status: 404 });
  }
  expect((await f.call(f.owner, "GET", `/artifacts/${fileId}`)).status).toBe(200);

  // Nobody else can share it, or even tell it apart from a missing file.
  const notFound = await f.call(f.other, "PUT", `/files/${fileId}/visibility`, {
    visibility: "workspace",
  });
  expect(notFound.status).toBe(404);
  expect(
    (await f.call(f.other, "PUT", `/files/${missing}/visibility`, { visibility: "workspace" }))
      .status,
  ).toBe(404);
  expect(
    (await f.call(f.owner, "PUT", `/files/not-a-uuid/visibility`, { visibility: "workspace" }))
      .status,
  ).toBe(404);

  // Its owner shares it, and is told who can open it now.
  const sharedResponse = await f.call(f.owner, "PUT", `/files/${fileId}/visibility`, {
    visibility: "workspace",
  });
  expect(sharedResponse.status, await sharedResponse.clone().text()).toBe(200);
  const sharedFile = ((await sharedResponse.json()) as { file: Record<string, unknown> }).file;
  expect(sharedFile).toMatchObject({
    id: fileId,
    scope: "workspace",
    ownerSubjectId: f.owner.subjectId,
    access: {
      visibility: "workspace",
      whoCanOpen: "Everyone in the workspace “Team workspace” can open this file.",
    },
  });
  expect((await f.call(f.other, "GET", `/artifacts/${fileId}`)).status).toBe(200);

  // Only its owner limits it again.
  const notOwner = await f.call(f.other, "PUT", `/files/${fileId}/visibility`, {
    visibility: "private",
  });
  expect(notOwner.status).toBe(403);
  const limited = await f.call(f.owner, "PUT", `/files/${fileId}/visibility`, {
    visibility: "private",
  });
  expect(limited.status, await limited.clone().text()).toBe(200);
  expect(
    ((await limited.json()) as { file: { access: { visibility: string } } }).file.access,
  ).toMatchObject({ visibility: "private" });
  expect((await f.call(f.other, "GET", `/artifacts/${fileId}`)).status).toBe(403);

  const audit =
    await shared.admin`select subject_id, metadata from audit_events where action='file.visibility.changed' and target_id=${fileId} order by occurred_at`;
  expect(audit.map((row) => row.subject_id)).toEqual([f.owner.subjectId, f.owner.subjectId]);
});

test("an upload says who will be able to open it", async () => {
  const f = await fixture();
  const upload = (scope?: "personal" | "workspace") =>
    f.call(f.owner, "POST", "/files/uploads", {
      filename: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 4,
      ...(scope ? { scope } : {}),
    });
  const team = await upload();
  expect(team.status, await team.clone().text()).toBe(201);
  expect(((await team.json()) as { access: unknown }).access).toEqual({
    visibility: "workspace",
    whoCanOpen: "Everyone in the workspace “Team workspace” can open this file.",
  });
  const mine = await upload("personal");
  expect(mine.status, await mine.clone().text()).toBe(201);
  const access = ((await mine.json()) as { access: { visibility: string; whoCanOpen: string } })
    .access;
  expect(access.visibility).toBe("private");
  // Names the owner, never "you": an agent or a shared chat may read it.
  expect(access.whoCanOpen).toStartWith("Only ");
  expect(access.whoCanOpen).not.toMatch(/\byou\b/iu);
  expect(access.whoCanOpen).toContain("is told it is private");
});

test("an app-shot travels with its screenshot and only with an image", async () => {
  const f = await fixture();
  const appShot = {
    app: "Safari",
    bundleId: "com.apple.Safari",
    title: "Example Domain",
    capturedAt: "2026-10-20T09:15:00.000Z",
    platform: "macos",
    text: "Example Domain\nThis domain is for use in documentation examples.",
    window: { processId: 812, windowId: 4211 },
  };
  const screenshot = await f.call(f.owner, "POST", "/files/uploads", {
    filename: "Safari - Example Domain.png",
    contentType: "image/png",
    sizeBytes: 4,
    appShot,
  });
  expect(screenshot.status, await screenshot.clone().text()).toBe(201);
  const { fileId } = (await screenshot.json()) as { fileId: string };
  const [row] = await shared.admin`select app_shot from files where id = ${fileId}`;
  expect(row!.app_shot).toEqual(appShot);
  const read = await f.call(f.owner, "GET", `/files/${fileId}`);
  expect(read.status, await read.clone().text()).toBe(200);
  expect(((await read.json()) as { appShot?: unknown }).appShot).toEqual(appShot);

  const notAnImage = await f.call(f.owner, "POST", "/files/uploads", {
    filename: "notes.txt",
    contentType: "text/plain",
    sizeBytes: 4,
    appShot,
  });
  expect(notAnImage.status).toBe(422);
});
