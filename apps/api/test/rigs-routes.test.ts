import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import {
  beginRigVersionVerificationAttempt,
  completeRigVersionVerification,
  createDb,
  createRigVersion,
  createSession,
  createVariableSet,
  getRigChange,
  listPendingInactiveRigVersionVerificationAttempts,
  listRigVersions,
  updateRigChangeStatus,
  withWorkspaceSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  createVerifiedTestRigVersion,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
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
    workflowClient: { startRigVerification: async () => {} } as never,
    managedAuth: null,
  } as never);
}

function appWithWorkflow(calls: unknown[]) {
  return createApp({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {
      startRigVerification: async (input: unknown) => {
        calls.push(input);
      },
    } as never,
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

async function auditActions(workspaceId: string, targetId: string): Promise<string[]> {
  const rows = await shared!.admin<{ action: string }[]>`
    select action from audit_events
    where workspace_id = ${workspaceId} and target_type = 'rig' and target_id = ${targetId}
    order by occurred_at asc`;
  return rows.map((r) => r.action);
}

async function rigVersionState(versionId: string): Promise<{
  active: boolean;
  verification: Record<string, unknown>;
}> {
  const [row] = await shared!.admin<
    Array<{ active: boolean; verification: Record<string, unknown> }>
  >`
    select active, verification from rig_versions where id = ${versionId}
  `;
  if (!row) throw new Error(`Rig version not found: ${versionId}`);
  return row;
}

function surfaceReceipt(versionId: string, sandboxGroupId = versionId) {
  return {
    version: 2 as const,
    checkedAt: "2026-08-30T12:00:00.000Z",
    binding: {
      leaseId: "11111111-2222-4333-8444-555555555555",
      sandboxGroupId,
      leaseEpoch: 2,
      workspaceGeneration: 1,
      instanceId: "sandbox-test",
      backendId: "modal",
      rigVersionId: versionId,
    },
    terminal: {
      status: "passed" as const,
      cwd: "/workspace" as const,
      uid: 0 as const,
      bunVersion: "1.4.0" as const,
      interactive: true as const,
    },
    browser: {
      status: "passed" as const,
      browserSessionId: "22222222-3333-4444-8555-666666666666",
      controllerGeneration: "rig-test",
      targetId: "page-1",
      observedTargetGeneration: "page-generation-1",
    },
    computer: { status: "disabled" as const },
  };
}

async function activateInitialVersion(workspaceId: string, rigId: string) {
  const [version] = await listRigVersions(client.db, workspaceId, rigId);
  if (!version) throw new Error("initial version missing");
  const attempt = await beginRigVersionVerificationAttempt(
    client.db,
    { workspaceId, rigId, versionId: version.id },
    { allowAlreadyPending: true },
  );
  const result = await completeRigVersionVerification(client.db, {
    workspaceId,
    rigId,
    versionId: version.id,
    attemptId: attempt.attemptId,
    receipt: surfaceReceipt(version.id),
  });
  expect(result.activated).toBe(true);
  return version;
}

describe("rig route permission matrix", () => {
  test("default Variable Set references require independent attach and use permissions", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const variableSet = await createVariableSet(client.db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      name: "rig-default-secret",
    });
    const base = `/v1/workspaces/${ws.workspaceId}/rigs`;
    const body = JSON.stringify({
      name: "secret-rig",
      defaultVariableSetIds: [variableSet.id],
    });

    for (const permissions of [
      ["rigs:manage", "variable-sets:use"],
      ["rigs:manage", "variable-sets:attach"],
    ] satisfies Permission[][]) {
      const denied = await app().request(base, {
        method: "POST",
        headers: { authorization: await bearer(ws, "user:m", permissions) },
        body,
      });
      expect(denied.status).toBe(403);
    }

    const accepted = await app().request(base, {
      method: "POST",
      headers: {
        authorization: await bearer(ws, "user:m", [
          "rigs:manage",
          "variable-sets:attach",
          "variable-sets:use",
        ]),
      },
      body,
    });
    expect(accepted.status).toBe(201);
  });

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
    const createBody = JSON.stringify({
      name: "gate",
      checks: [{ name: "ok", command: "true" }],
    });
    expect(
      (await app().request(base, { method: "POST", headers: useOnly, body: createBody })).status,
    ).toBe(403);
    const created = await app().request(base, {
      method: "POST",
      headers: manage,
      body: createBody,
    });
    expect(created.status).toBe(201);
    const rig = await created.json();
    expect(rig.activeVersion).toBeNull();
    const initialVersion = (await listRigVersions(client.db, ws.workspaceId, rig.id))[0]!;
    expect(initialVersion.version).toBe(1);
    expect(initialVersion.image).toBeNull();

    const explicitImage = await app().request(base, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({ name: "custom-base", image: "ubuntu:24.04" }),
    });
    expect(explicitImage.status).toBe(422);
    expect(await explicitImage.json()).toMatchObject({
      error: {
        code: "validation_failed",
        details: { code: "RIG_IMAGE_OVERRIDE_UNSUPPORTED" },
      },
    });

    // Get: rigs:use OK.
    expect((await app().request(`${base}/${rig.id}`, { headers: useOnly })).status).toBe(200);

    // Patch/Delete: rigs:manage only.
    const patch = JSON.stringify({ description: "d" });
    expect(
      (await app().request(`${base}/${rig.id}`, { method: "PATCH", headers: useOnly, body: patch }))
        .status,
    ).toBe(403);
    expect(
      (await app().request(`${base}/${rig.id}`, { method: "PATCH", headers: manage, body: patch }))
        .status,
    ).toBe(200);
    const explicitPatchImage = await app().request(`${base}/${rig.id}`, {
      method: "PATCH",
      headers: manage,
      body: JSON.stringify({ image: null }),
    });
    expect(explicitPatchImage.status).toBe(422);
    expect(await explicitPatchImage.json()).toMatchObject({
      error: { details: { code: "RIG_IMAGE_OVERRIDE_UNSUPPORTED" } },
    });

    // Activate: rigs:manage only.
    const versionId = initialVersion.id;
    const activatePath = `${base}/${rig.id}/versions/${versionId}/activate`;
    expect((await app().request(activatePath, { method: "POST", headers: useOnly })).status).toBe(
      403,
    );
    expect((await app().request(activatePath, { method: "POST", headers: manage })).status).toBe(
      422,
    );
    await activateInitialVersion(ws.workspaceId, rig.id);
    expect((await app().request(activatePath, { method: "POST", headers: manage })).status).toBe(
      200,
    );

    // Propose change: rigs:use OK, none -> 403.
    const proposeBody = JSON.stringify({
      kind: "setup_append",
      payload: { command: "apt-get install -y jq" },
    });
    const changesPath = `${base}/${rig.id}/changes`;
    const explicitChangeImage = await app().request(changesPath, {
      method: "POST",
      headers: useOnly,
      body: JSON.stringify({
        kind: "definition_edit",
        payload: { image: "ubuntu:24.04" },
      }),
    });
    expect(explicitChangeImage.status).toBe(422);
    expect(await explicitChangeImage.json()).toMatchObject({
      error: { details: { code: "RIG_IMAGE_OVERRIDE_UNSUPPORTED" } },
    });
    expect(
      (await app().request(changesPath, { method: "POST", headers: none, body: proposeBody }))
        .status,
    ).toBe(403);
    const proposed = await app().request(changesPath, {
      method: "POST",
      headers: useOnly,
      body: proposeBody,
    });
    expect(proposed.status).toBe(201);
    const change = await proposed.json();
    expect(change.status).toBe("verifying");
    expect(change.baseVersionId).toBe(versionId);

    // Get change: rigs:use OK.
    expect((await app().request(`${changesPath}/${change.id}`, { headers: useOnly })).status).toBe(
      200,
    );

    // Every mutation wrote an audit row.
    expect(await auditActions(ws.workspaceId, rig.id)).toEqual([
      "rig.created",
      "rig.version.verification.requested",
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
    const created = await app().request(base, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({ name: "del" }),
    });
    const rig = await created.json();
    await activateInitialVersion(ws.workspaceId, rig.id);

    const session = await createSession(client.db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      rigId: rig.id,
    });

    const blocked = await app().request(`${base}/${rig.id}`, { method: "DELETE", headers: manage });
    expect(blocked.status).toBe(409);

    // Drop the reference, then delete succeeds + audits.
    await withWorkspaceSessionActivityRls(client.db, ws.workspaceId, async (tx) => {
      await tx.execute(
        sql`update sessions set rig_id = null where workspace_id = ${ws.workspaceId} and id = ${session.id}`,
      );
    });
    const ok = await app().request(`${base}/${rig.id}`, { method: "DELETE", headers: manage });
    expect(ok.status).toBe(200);
    expect(await auditActions(ws.workspaceId, rig.id)).toContain("rig.deleted");
  });

  test("verification starts are deterministic and retrying an in-flight attempt is idempotent", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const calls: unknown[] = [];
    const http = appWithWorkflow(calls);
    const use = { authorization: await bearer(ws, "user:u", ["rigs:use", "rigs:manage"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/rigs`;
    const created = await http.request(base, {
      method: "POST",
      headers: use,
      body: JSON.stringify({ name: "retry-verify" }),
    });
    const rig = await created.json();
    const [initialVersion] = await listRigVersions(client.db, ws.workspaceId, rig.id);
    expect(initialVersion).toBeDefined();
    await activateInitialVersion(ws.workspaceId, rig.id);
    const proposed = await http.request(`${base}/${rig.id}/changes`, {
      method: "POST",
      headers: use,
      body: JSON.stringify({ kind: "setup_append", payload: { command: "true" } }),
    });
    expect(proposed.status).toBe(201);
    const change = await proposed.json();
    expect(calls).toHaveLength(2);
    const initialCall = calls[0] as { attemptId: string; workflowId: string };
    expect(initialCall.attemptId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(initialCall.workflowId).toBe(
      `rig-verification-version-${initialVersion!.id}-attempt-${initialCall.attemptId}`,
    );
    expect((calls[1] as { workflowId: string }).workflowId).toBe(
      `rig-verification-change-${change.id}-attempt-1`,
    );

    await updateRigChangeStatus(client.db, ws.workspaceId, change.id, {
      status: "failed",
      verification: { error: "transient" },
    });
    const retry = await http.request(`${base}/${rig.id}/changes/${change.id}/verify`, {
      method: "POST",
      headers: use,
    });
    expect(retry.status).toBe(202);
    const retryBody = await retry.json();
    expect(retryBody.status).toBe("verifying");
    expect(calls).toHaveLength(3);
    expect((calls[2] as { workflowId: string }).workflowId).toBe(
      `rig-verification-change-${change.id}-attempt-2`,
    );
    expect((await getRigChange(client.db, ws.workspaceId, change.id))?.status).toBe("verifying");

    const duplicate = await http.request(`${base}/${rig.id}/changes/${change.id}/verify`, {
      method: "POST",
      headers: use,
    });
    expect(duplicate.status).toBe(202);
    expect(calls).toHaveLength(4);
    expect((calls[3] as { workflowId: string }).workflowId).toBe(
      `rig-verification-change-${change.id}-attempt-2`,
    );
  });

  test("repeated version verification requests reuse one in-flight attempt", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const calls: Array<{ workflowId: string; attemptId: string }> = [];
    const http = createApp({
      settings,
      db: client.db,
      bus: {} as never,
      workflowClient: {
        startRigVerification: async (input: { workflowId: string; attemptId: string }) => {
          calls.push(input);
        },
      } as never,
      managedAuth: null,
    } as never);
    const manage = { authorization: await bearer(ws, "user:m", ["rigs:use", "rigs:manage"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/rigs`;
    const created = await http.request(base, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({ name: "version-single-flight" }),
    });
    const rig = await created.json();
    const [version] = await listRigVersions(client.db, ws.workspaceId, rig.id);
    expect(version).toBeDefined();

    const endpoint = `${base}/${rig.id}/versions/${version!.id}/verify`;
    const first = await http.request(endpoint, { method: "POST", headers: manage });
    const second = await http.request(endpoint, { method: "POST", headers: manage });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect((await first.json()).versionId).toBe(version!.id);
    expect((await second.json()).versionId).toBe(version!.id);
    expect(calls).toHaveLength(3);
    const attemptId = calls[0]!.attemptId;
    expect(attemptId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(new Set(calls.map((call) => call.workflowId))).toEqual(
      new Set([`rig-verification-version-${version!.id}-attempt-${attemptId}`]),
    );
    expect(calls.every((call) => call.attemptId === attemptId)).toBe(true);
  });

  test("exact-version dispatch outage returns committed pending truth and reuses one attempt", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const calls: Array<{ workflowId: string; versionId: string; attemptId: string }> = [];
    let dispatcherAvailable = true;
    const http = createApp({
      settings,
      db: client.db,
      bus: {} as never,
      workflowClient: {
        startRigVerification: async (input: {
          workflowId: string;
          versionId: string;
          attemptId: string;
        }) => {
          calls.push(input);
          if (!dispatcherAvailable) throw new Error("temporal unavailable");
        },
      } as never,
      managedAuth: null,
    } as never);
    const manage = { authorization: await bearer(ws, "user:m", ["rigs:use", "rigs:manage"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/rigs`;
    const created = await http.request(base, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({ name: "exact-version-dispatch-outage" }),
    });
    const rig = await created.json();
    const initialVersion = await activateInitialVersion(ws.workspaceId, rig.id);
    const candidate = await createRigVersion(client.db, ws.workspaceId, rig.id, {
      setupScript: "echo candidate",
    });
    dispatcherAvailable = false;
    const endpoint = `${base}/${rig.id}/versions/${candidate.id}/verify`;

    const first = await http.request(endpoint, { method: "POST", headers: manage });
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({
      error: {
        code: "upstream_unavailable",
        retryable: true,
        outcomeUnknown: true,
        details: {
          code: "RIG_VERIFICATION_DISPATCH_DEFERRED",
          versionId: candidate.id,
          verificationStatus: "pending",
        },
      },
    });
    const stateAfterFirst = await rigVersionState(candidate.id);
    expect(stateAfterFirst).toMatchObject({
      active: false,
      verification: { status: "pending" },
    });

    const second = await http.request(endpoint, { method: "POST", headers: manage });
    expect(second.status).toBe(503);
    expect(await second.json()).toMatchObject({
      error: {
        details: { versionId: candidate.id, verificationStatus: "pending" },
      },
    });
    expect(await rigVersionState(candidate.id)).toEqual(stateAfterFirst);
    const failedDispatches = calls.slice(-2);
    expect(failedDispatches).toHaveLength(2);
    expect(failedDispatches[1]).toEqual(failedDispatches[0]);
    expect(failedDispatches[0]?.workflowId).toBe(
      `rig-verification-version-${candidate.id}-attempt-${failedDispatches[0]?.attemptId}`,
    );
    const current = await http.request(`${base}/${rig.id}`, { headers: manage });
    expect((await current.json()).activeVersion.id).toBe(initialVersion.id);
  });

  test("active-version dispatch outage returns committed pending truth and reuses one attempt", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const calls: Array<{ workflowId: string; versionId: string; attemptId: string }> = [];
    let dispatcherAvailable = true;
    const http = createApp({
      settings,
      db: client.db,
      bus: {} as never,
      workflowClient: {
        startRigVerification: async (input: {
          workflowId: string;
          versionId: string;
          attemptId: string;
        }) => {
          calls.push(input);
          if (!dispatcherAvailable) throw new Error("temporal unavailable");
        },
      } as never,
      managedAuth: null,
    } as never);
    const use = { authorization: await bearer(ws, "user:u", ["rigs:use"]) };
    const manage = { authorization: await bearer(ws, "user:m", ["rigs:use", "rigs:manage"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/rigs`;
    const created = await http.request(base, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({ name: "active-version-dispatch-outage" }),
    });
    const rig = await created.json();
    const activeVersion = await activateInitialVersion(ws.workspaceId, rig.id);
    dispatcherAvailable = false;
    const endpoint = `${base}/${rig.id}/verify`;

    const first = await http.request(endpoint, { method: "POST", headers: use });
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({
      error: {
        code: "upstream_unavailable",
        retryable: true,
        outcomeUnknown: true,
        details: {
          code: "RIG_VERIFICATION_DISPATCH_DEFERRED",
          versionId: activeVersion.id,
          verificationStatus: "pending",
        },
      },
    });
    const stateAfterFirst = await rigVersionState(activeVersion.id);
    expect(stateAfterFirst).toMatchObject({
      active: true,
      verification: { status: "pending" },
    });

    const second = await http.request(endpoint, { method: "POST", headers: use });
    expect(second.status).toBe(503);
    expect(await rigVersionState(activeVersion.id)).toEqual(stateAfterFirst);
    const failedDispatches = calls.slice(-2);
    expect(failedDispatches).toHaveLength(2);
    expect(failedDispatches[1]).toEqual(failedDispatches[0]);
    expect(failedDispatches[0]?.workflowId).toBe(
      `rig-verification-version-${activeVersion.id}-attempt-${failedDispatches[0]?.attemptId}`,
    );
  });

  test("exact version verification is manager-only and use-only denial has zero side effects", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const calls: Array<{ workflowId: string; attemptId: string }> = [];
    const http = createApp({
      settings,
      db: client.db,
      bus: {} as never,
      workflowClient: {
        startRigVerification: async (input: { workflowId: string; attemptId: string }) => {
          calls.push(input);
        },
      } as never,
      managedAuth: null,
    } as never);
    const manager = {
      authorization: await bearer(ws, "user:m", ["rigs:use", "rigs:manage"]),
    };
    const useOnly = { authorization: await bearer(ws, "user:u", ["rigs:use"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/rigs`;
    const created = await http.request(base, {
      method: "POST",
      headers: manager,
      body: JSON.stringify({ name: "manager-exact-version" }),
    });
    const rig = await created.json();
    const [pendingBefore] = await listPendingInactiveRigVersionVerificationAttempts(
      client.db,
      ws.workspaceId,
      rig.id,
    );
    expect(pendingBefore).toBeDefined();
    const callsBefore = [...calls];
    const auditsBefore = await auditActions(ws.workspaceId, rig.id);

    const denied = await http.request(
      `${base}/${rig.id}/versions/${pendingBefore!.versionId}/verify`,
      { method: "POST", headers: useOnly },
    );
    expect(denied.status).toBe(403);
    expect(calls).toEqual(callsBefore);
    expect(
      await listPendingInactiveRigVersionVerificationAttempts(client.db, ws.workspaceId, rig.id),
    ).toEqual([pendingBefore]);
    expect(await auditActions(ws.workspaceId, rig.id)).toEqual(auditsBefore);

    const accepted = await http.request(
      `${base}/${rig.id}/versions/${pendingBefore!.versionId}/verify`,
      { method: "POST", headers: manager },
    );
    expect(accepted.status).toBe(202);
    expect(calls).toHaveLength(callsBefore.length + 1);
    expect(calls.at(-1)?.attemptId).toBe(pendingBefore!.attemptId);
  });

  test("a committed rig create survives an unavailable initial verification dispatcher", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const calls: Array<{ workflowId: string; attemptId: string }> = [];
    let dispatcherAvailable = false;
    const http = createApp({
      settings,
      db: client.db,
      bus: {} as never,
      workflowClient: {
        startRigVerification: async (input: { workflowId: string; attemptId: string }) => {
          calls.push(input);
          if (!dispatcherAvailable) throw new Error("temporal unavailable");
        },
      } as never,
      managedAuth: null,
    } as never);
    const manage = { authorization: await bearer(ws, "user:m", ["rigs:use", "rigs:manage"]) };
    const useOnly = { authorization: await bearer(ws, "user:u", ["rigs:use"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/rigs`;
    const created = await http.request(base, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({ name: "deferred-initial-verification" }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("OpenGeni-Rig-Verification")).toBe("deferred");
    const rig = await created.json();
    expect(rig.activeVersion).toBeNull();
    const [version] = await listRigVersions(client.db, ws.workspaceId, rig.id);
    expect(version?.active).toBe(false);
    expect(version?.verificationStatus).toBe("pending");
    expect((await http.request(`${base}/${rig.id}`, { headers: manage })).status).toBe(200);
    expect(
      (
        await http.request(`${base}/${rig.id}/versions/${version!.id}/activate`, {
          method: "POST",
          headers: manage,
        })
      ).status,
    ).toBe(422);

    const [pendingBefore] = await listPendingInactiveRigVersionVerificationAttempts(
      client.db,
      ws.workspaceId,
      rig.id,
    );
    expect(pendingBefore?.versionId).toBe(version!.id);
    const deferredRecovery = await http.request(`${base}/${rig.id}/versions/recover`, {
      method: "POST",
      headers: useOnly,
    });
    expect(deferredRecovery.status).toBe(503);
    expect(await deferredRecovery.json()).toMatchObject({
      error: {
        code: "upstream_unavailable",
        retryable: true,
        outcomeUnknown: true,
        details: {
          code: "RIG_VERIFICATION_DISPATCH_DEFERRED",
          versionId: version!.id,
        },
      },
    });
    expect(
      await listPendingInactiveRigVersionVerificationAttempts(client.db, ws.workspaceId, rig.id),
    ).toEqual([pendingBefore]);

    dispatcherAvailable = true;
    const recovered = await http.request(`${base}/${rig.id}/versions/recover`, {
      method: "POST",
      headers: useOnly,
    });
    expect(recovered.status).toBe(202);
    expect(await recovered.json()).toEqual({ ok: true, versionId: version!.id });
    expect(calls.map((call) => call.attemptId)).toEqual([
      pendingBefore!.attemptId,
      pendingBefore!.attemptId,
      pendingBefore!.attemptId,
    ]);
    const [{ count } = { count: 0 }] = await shared!.admin<Array<{ count: number }>>`
      select count(*)::int as count from rigs
      where workspace_id = ${ws.workspaceId} and name = 'deferred-initial-verification'
    `;
    expect(Number(count)).toBe(1);
  });

  test("deferred version recovery fails closed on zero or ambiguous pending candidates", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const calls: unknown[] = [];
    const http = createApp({
      settings,
      db: client.db,
      bus: {} as never,
      workflowClient: {
        startRigVerification: async (input: unknown) => {
          calls.push(input);
          throw new Error("temporal unavailable");
        },
      } as never,
      managedAuth: null,
    } as never);
    const manager = {
      authorization: await bearer(ws, "user:m", ["rigs:use", "rigs:manage"]),
    };
    const useOnly = { authorization: await bearer(ws, "user:u", ["rigs:use"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/rigs`;
    const created = await http.request(base, {
      method: "POST",
      headers: manager,
      body: JSON.stringify({ name: "ambiguous-deferred-version" }),
    });
    const rig = await created.json();
    const authored = await http.request(`${base}/${rig.id}/versions`, {
      method: "POST",
      headers: manager,
      body: JSON.stringify({ setupScript: "echo second" }),
    });
    expect(authored.status).toBe(201);
    const pendingBefore = await listPendingInactiveRigVersionVerificationAttempts(
      client.db,
      ws.workspaceId,
      rig.id,
    );
    expect(pendingBefore).toHaveLength(2);
    const callsBeforeAmbiguous = calls.length;
    const ambiguous = await http.request(`${base}/${rig.id}/versions/recover`, {
      method: "POST",
      headers: useOnly,
    });
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({
      error: {
        code: "conflict",
        retryable: false,
        outcomeUnknown: false,
        details: { code: "RIG_DEFERRED_VERIFICATION_AMBIGUOUS", candidateCount: 2 },
      },
    });
    expect(calls).toHaveLength(callsBeforeAmbiguous);
    expect(
      await listPendingInactiveRigVersionVerificationAttempts(client.db, ws.workspaceId, rig.id),
    ).toEqual(pendingBefore);

    const activeRigResponse = await app().request(base, {
      method: "POST",
      headers: manager,
      body: JSON.stringify({ name: "no-deferred-version" }),
    });
    const activeRig = await activeRigResponse.json();
    await activateInitialVersion(ws.workspaceId, activeRig.id);
    const none = await http.request(`${base}/${activeRig.id}/versions/recover`, {
      method: "POST",
      headers: useOnly,
    });
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({
      error: {
        code: "conflict",
        details: { code: "RIG_DEFERRED_VERIFICATION_NOT_FOUND", candidateCount: 0 },
      },
    });
    expect(calls).toHaveLength(callsBeforeAmbiguous);
  });

  test("a committed proposal reports deferred dispatch and retries the same verification attempt", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const calls: Array<{ workflowId: string }> = [];
    const http = createApp({
      settings,
      db: client.db,
      bus: {} as never,
      workflowClient: {
        startRigVerification: async (input: { workflowId: string }) => {
          calls.push(input);
          if (calls.length === 2) throw new Error("temporal unavailable");
        },
      } as never,
      managedAuth: null,
    } as never);
    const manage = { authorization: await bearer(ws, "user:m", ["rigs:use", "rigs:manage"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/rigs`;
    const created = await http.request(base, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({ name: "deferred-change-verification" }),
    });
    const rig = await created.json();
    await activateInitialVersion(ws.workspaceId, rig.id);
    const proposed = await http.request(`${base}/${rig.id}/changes`, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({ kind: "setup_append", payload: { command: "true" } }),
    });
    expect(proposed.status).toBe(201);
    expect(proposed.headers.get("OpenGeni-Rig-Verification")).toBe("deferred");
    const change = await proposed.json();
    expect(change.status).toBe("verifying");

    const retried = await http.request(`${base}/${rig.id}/changes/${change.id}/verify`, {
      method: "POST",
      headers: manage,
    });
    expect(retried.status).toBe(202);
    expect(retried.headers.get("OpenGeni-Rig-Verification")).toBeNull();
    expect(calls[1]?.workflowId).toBe(calls[2]?.workflowId);
  });

  test("definition_edit promote rejects a stale active base without minting", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const calls: unknown[] = [];
    const http = appWithWorkflow(calls);
    const manage = { authorization: await bearer(ws, "user:m", ["rigs:use", "rigs:manage"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/rigs`;
    const created = await http.request(base, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({ name: "stale-promote", setupScript: "echo v1" }),
    });
    const rig = await created.json();
    await activateInitialVersion(ws.workspaceId, rig.id);
    const proposed = await http.request(`${base}/${rig.id}/changes`, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({
        kind: "definition_edit",
        payload: { setupScript: "echo edited", checks: [] },
      }),
    });
    const change = await proposed.json();
    await updateRigChangeStatus(client.db, ws.workspaceId, change.id, {
      status: "proposed",
      verification: {
        passed: true,
        platformSurfaceValidation: surfaceReceipt(change.id),
      },
    });
    await createVerifiedTestRigVersion(client.db, ws.workspaceId, rig.id, {
      setupScript: "echo independently-promoted",
    });

    const promoted = await http.request(`${base}/${rig.id}/changes/${change.id}/promote`, {
      method: "POST",
      headers: manage,
    });
    expect(promoted.status).toBe(409);
    const versions = await listRigVersions(client.db, ws.workspaceId, rig.id);
    expect(versions).toHaveLength(2);
    expect((await getRigChange(client.db, ws.workspaceId, change.id))?.status).toBe("proposed");
  });

  test("manager-authored versions stay inactive when verification dispatch is deferred", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const calls: Array<{ versionId: string; attemptId: string; workflowId: string }> = [];
    const http = createApp({
      settings,
      db: client.db,
      bus: {} as never,
      workflowClient: {
        startRigVerification: async (input: {
          versionId: string;
          attemptId: string;
          workflowId: string;
        }) => {
          calls.push(input);
          if (calls.length === 2) throw new Error("temporal unavailable");
        },
      } as never,
      managedAuth: null,
    } as never);
    const manage = { authorization: await bearer(ws, "user:m", ["rigs:use", "rigs:manage"]) };
    const base = `/v1/workspaces/${ws.workspaceId}/rigs`;
    const created = await http.request(base, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({ name: "direct-version-pending", setupScript: "echo v1" }),
    });
    const rig = await created.json();
    const initialVersion = await activateInitialVersion(ws.workspaceId, rig.id);
    const authored = await http.request(`${base}/${rig.id}/versions`, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({ setupScript: "echo v2" }),
    });
    expect(authored.status).toBe(201);
    expect(authored.headers.get("OpenGeni-Rig-Verification")).toBe("deferred");
    const version = await authored.json();
    expect(version.active).toBe(false);
    const fetched = await http.request(`${base}/${rig.id}`, { headers: manage });
    expect((await fetched.json()).activeVersion.id).toBe(initialVersion.id);
    const activation = await http.request(`${base}/${rig.id}/versions/${version.id}/activate`, {
      method: "POST",
      headers: manage,
    });
    expect(activation.status).toBe(422);
    const retried = await http.request(`${base}/${rig.id}/versions/${version.id}/verify`, {
      method: "POST",
      headers: manage,
    });
    expect(retried.status).toBe(202);
    expect(calls[1]?.attemptId).toBe(calls[2]?.attemptId);
    expect(calls[1]?.workflowId).toBe(calls[2]?.workflowId);
    expect(calls[2]?.workflowId).toBe(
      `rig-verification-version-${version.id}-attempt-${calls[2]?.attemptId}`,
    );
  });

  test("workspace default rig setter is rigs:manage gated, validates rigId, and clears", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const useOnly = { authorization: await bearer(ws, "user:u", ["rigs:use", "workspace:read"]) };
    const manage = { authorization: await bearer(ws, "user:m", ["rigs:manage", "workspace:read"]) };
    const base = `/v1/workspaces/${ws.workspaceId}`;
    const created = await app().request(`${base}/rigs`, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({ name: "default-target" }),
    });
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
    const first = await app().request(base, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({ name: "dup" }),
    });
    expect(first.status).toBe(201);
    const collision = await app().request(base, {
      method: "POST",
      headers: manage,
      body: JSON.stringify({ name: "dup" }),
    });
    expect(collision.status).toBe(409);

    const badRef = await app().request(base, {
      method: "POST",
      headers: {
        authorization: await bearer(ws, "user:m", [
          "rigs:manage",
          "variable-sets:attach",
          "variable-sets:use",
        ]),
      },
      body: JSON.stringify({
        name: "bad-ref",
        defaultVariableSetIds: ["11111111-1111-4111-8111-111111111111"],
      }),
    });
    expect(badRef.status).toBe(422);
  });
});
