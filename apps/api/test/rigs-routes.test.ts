import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { createDb, createRigVersion, getRigChange, listRigVersions, updateRigChangeStatus, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, testSettings, type SharedTestDatabase } from "@opengeni/testing";
import { createApp } from "../src/app";

const DELEGATION_SECRET = "rigs-routes-delegation-secret";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;

const encryptionKey = randomBytes(32).toString("base64");

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_rigs");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[rigs-routes] docker unavailable, skipping");
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
  } catch { /* noop */ }
  await shared?.release();
}, 180_000);

function app() {
  return createApp({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: { startRigVerification: async () => {} } as never,
    managedAuth: null,
  } as never);
}

function appWithWorkflow(calls: unknown[]) {
  return createApp({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: { startRigVerification: async (input: unknown) => { calls.push(input); } } as never,
    managedAuth: null,
  } as never);
}

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
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
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `Bearer ${token}`;
}

async function auditActions(workspaceId: string, targetId: string): Promise<string[]> {
  const rows = await shared!.admin<{ action: string }[]>`
    select action from audit_events
    where workspace_id = ${workspaceId} and target_type = 'rig' and target_id = ${targetId}
    order by occurred_at asc`;
  return rows.map((r) => r.action);
}

describe("rig route permission matrix", () => {
  test("read requires rigs:use; write requires rigs:manage; propose requires rigs:use", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const manage = { authorization: await bearer(ws, "user:m", ["rigs:use", "rigs:manage"]) };
    const useOnly = { authorization: await bearer(ws, "user:u", ["rigs:use"]) };
    const none = { authorization: await bearer(ws, "user:n", ["sessions:read"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/rigs`;

    // List: rigs:use OK, no rig perms -> 403.
    expect((await app().request(base, { headers: useOnly })).status).toBe(200);
    expect((await app().request(base, { headers: none })).status).toBe(403);

    // Create: rigs:manage only.
    const createBody = JSON.stringify({ name: "gate", image: "ubuntu:24.04", checks: [{ name: "ok", command: "true" }] });
    expect((await app().request(base, { method: "POST", headers: useOnly, body: createBody })).status).toBe(403);
    const created = await app().request(base, { method: "POST", headers: manage, body: createBody });
    expect(created.status).toBe(201);
    const rig = await created.json();
    expect(rig.activeVersion.version).toBe(1);

    // Get: rigs:use OK.
    expect((await app().request(`${base}/${rig.id}`, { headers: useOnly })).status).toBe(200);

    // Patch/Delete: rigs:manage only.
    const patch = JSON.stringify({ description: "d" });
    expect((await app().request(`${base}/${rig.id}`, { method: "PATCH", headers: useOnly, body: patch })).status).toBe(403);
    expect((await app().request(`${base}/${rig.id}`, { method: "PATCH", headers: manage, body: patch })).status).toBe(200);

    // Activate: rigs:manage only.
    const versionId = rig.activeVersion.id;
    const activatePath = `${base}/${rig.id}/versions/${versionId}/activate`;
    expect((await app().request(activatePath, { method: "POST", headers: useOnly })).status).toBe(403);
    expect((await app().request(activatePath, { method: "POST", headers: manage })).status).toBe(200);

    // Propose change: rigs:use OK, none -> 403.
    const proposeBody = JSON.stringify({ kind: "setup_append", payload: { command: "apt-get install -y jq" } });
    const changesPath = `${base}/${rig.id}/changes`;
    expect((await app().request(changesPath, { method: "POST", headers: none, body: proposeBody })).status).toBe(403);
    const proposed = await app().request(changesPath, { method: "POST", headers: useOnly, body: proposeBody });
    expect(proposed.status).toBe(201);
    const change = await proposed.json();
    expect(change.status).toBe("verifying");
    expect(change.baseVersionId).toBe(versionId);

    // Get change: rigs:use OK.
    expect((await app().request(`${changesPath}/${change.id}`, { headers: useOnly })).status).toBe(200);

    // Every mutation wrote an audit row.
    expect(await auditActions(ws.workspaceId, rig.id)).toEqual([
      "rig.created",
      "rig.updated",
      "rig.version.activated",
      "rig.change.proposed",
    ]);
  });

  test("delete is blocked while a session references the rig, then succeeds", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const manage = { authorization: await bearer(ws, "user:m", ["rigs:manage"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/rigs`;
    const created = await app().request(base, { method: "POST", headers: manage, body: JSON.stringify({ name: "del" }) });
    const rig = await created.json();

    const [session] = await shared!.admin<{ id: string }[]>`
      insert into sessions (account_id, workspace_id, initial_message, model, sandbox_backend, sandbox_group_id, rig_id)
      values (${ws.accountId}, ${ws.workspaceId}, 'hi', 'gpt-5.5', 'none', gen_random_uuid(), ${rig.id})
      returning id`;

    const blocked = await app().request(`${base}/${rig.id}`, { method: "DELETE", headers: manage });
    expect(blocked.status).toBe(409);

    // Drop the reference, then delete succeeds + audits.
    await shared!.admin`update sessions set rig_id = null where id = ${session!.id}`;
    const ok = await app().request(`${base}/${rig.id}`, { method: "DELETE", headers: manage });
    expect(ok.status).toBe(200);
    expect(await auditActions(ws.workspaceId, rig.id)).toContain("rig.deleted");
  });

  test("verify retries a failed change with a unique attempt workflow and rejects concurrent verifying", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const calls: unknown[] = [];
    const http = appWithWorkflow(calls);
    const use = { authorization: await bearer(ws, "user:u", ["rigs:use", "rigs:manage"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/rigs`;
    const created = await http.request(base, { method: "POST", headers: use, body: JSON.stringify({ name: "retry-verify" }) });
    const rig = await created.json();
    const proposed = await http.request(`${base}/${rig.id}/changes`, {
      method: "POST",
      headers: use,
      body: JSON.stringify({ kind: "setup_append", payload: { command: "true" } }),
    });
    expect(proposed.status).toBe(201);
    const change = await proposed.json();
    expect(calls).toHaveLength(1);
    expect((calls[0] as { workflowId: string }).workflowId).toBe(`rig-verification-change-${change.id}-attempt-1`);

    await updateRigChangeStatus(client.db, ws.workspaceId, change.id, {
      status: "failed",
      verification: { error: "transient" },
    });
    const retry = await http.request(`${base}/${rig.id}/changes/${change.id}/verify`, { method: "POST", headers: use });
    expect(retry.status).toBe(202);
    const retryBody = await retry.json();
    expect(retryBody.status).toBe("verifying");
    expect(calls).toHaveLength(2);
    expect((calls[1] as { workflowId: string }).workflowId).toBe(`rig-verification-change-${change.id}-attempt-2`);
    expect((await getRigChange(client.db, ws.workspaceId, change.id))?.status).toBe("verifying");

    const duplicate = await http.request(`${base}/${rig.id}/changes/${change.id}/verify`, { method: "POST", headers: use });
    expect(duplicate.status).toBe(409);
    expect(calls).toHaveLength(2);
  });

  test("definition_edit promote rejects a stale active base without minting", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const calls: unknown[] = [];
    const http = appWithWorkflow(calls);
    const manage = { authorization: await bearer(ws, "user:m", ["rigs:use", "rigs:manage"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/rigs`;
    const created = await http.request(base, { method: "POST", headers: manage, body: JSON.stringify({ name: "stale-promote", setupScript: "echo v1" }) });
    const rig = await created.json();
    const proposed = await http.request(`${base}/${rig.id}/changes`, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({ kind: "definition_edit", payload: { setupScript: "echo edited", checks: [] } }),
    });
    const change = await proposed.json();
    await updateRigChangeStatus(client.db, ws.workspaceId, change.id, {
      status: "proposed",
      verification: { passed: true },
    });
    await createRigVersion(client.db, ws.workspaceId, rig.id, { setupScript: "echo independently-promoted" }, { activate: true });

    const promoted = await http.request(`${base}/${rig.id}/changes/${change.id}/promote`, { method: "POST", headers: manage });
    expect(promoted.status).toBe(409);
    const versions = await listRigVersions(client.db, ws.workspaceId, rig.id);
    expect(versions).toHaveLength(2);
    expect((await getRigChange(client.db, ws.workspaceId, change.id))?.status).toBe("proposed");
  });

  test("workspace default rig setter is rigs:manage gated, validates rigId, and clears", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const useOnly = { authorization: await bearer(ws, "user:u", ["rigs:use", "workspace:read"]) };
    const manage = { authorization: await bearer(ws, "user:m", ["rigs:manage", "workspace:read"]) };
    const base = `/v1/workspaces/${ws.workspaceId}`;
    const created = await app().request(`${base}/rigs`, { method: "POST", headers: manage, body: JSON.stringify({ name: "default-target" }) });
    const rig = await created.json();

    const denied = await app().request(`${base}/default-rig`, {
      method: "PUT",
      headers: useOnly,
      body: JSON.stringify({ rigId: rig.id }),
    });
    expect(denied.status).toBe(403);

    const invalid = await app().request(`${base}/default-rig`, {
      method: "PUT",
      headers: manage,
      body: JSON.stringify({ rigId: "11111111-1111-4111-8111-111111111111" }),
    });
    expect(invalid.status).toBe(422);

    const set = await app().request(`${base}/default-rig`, {
      method: "PUT",
      headers: manage,
      body: JSON.stringify({ rigId: rig.id }),
    });
    expect(set.status).toBe(200);
    expect((await set.json()).defaultRigId).toBe(rig.id);
    const fetched = await app().request(base, { headers: manage });
    expect((await fetched.json()).defaultRigId).toBe(rig.id);

    const cleared = await app().request(`${base}/default-rig`, {
      method: "PUT",
      headers: manage,
      body: JSON.stringify({ rigId: null }),
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).defaultRigId).toBeNull();
  });

  test("name collision is a 409; unknown defaultVariableSetId is a 422", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const manage = { authorization: await bearer(ws, "user:m", ["rigs:manage"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/rigs`;
    const first = await app().request(base, { method: "POST", headers: manage, body: JSON.stringify({ name: "dup" }) });
    expect(first.status).toBe(201);
    const collision = await app().request(base, { method: "POST", headers: manage, body: JSON.stringify({ name: "dup" }) });
    expect(collision.status).toBe(409);

    const badRef = await app().request(base, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({ name: "bad-ref", defaultVariableSetIds: ["11111111-1111-4111-8111-111111111111"] }),
    });
    expect(badRef.status).toBe(422);
  });
});
