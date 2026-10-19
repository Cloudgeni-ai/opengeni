import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { sql } from "drizzle-orm";
import { rawRows } from "../src/database";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createWorkspace,
  initializeSessionStartAtomically,
  registerConnectedSecretScope,
  requestConnectedSecretScopeClose,
  completeConnectedSecretScope,
  claimConnectedSecretScopes,
  deferConnectedSecretScope,
} from "../src";

let shared: OwnerMigratedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("connected-secret-files");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  await migrate(shared.ownerUrl);
  await provisionRoles(shared.adminUrl, {
    appRole: "opengeni_app",
    appPassword: shared.appPassword,
    rlsStrategy: "force",
  });
  const appUrl = new URL(shared.adminUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = shared.appPassword;
  client = createDb(appUrl.toString());
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function fixture(crossWorkspace = false) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Secret cleanup",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Secret cleanup",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const controlWorkspaceId = crossWorkspace
    ? (await createWorkspace(client.db, { accountId: grant.accountId, name: "Machine control" })).id
    : workspaceId;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "Run command",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("fixture claim failed");
  const owner = {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
  const target = {
    controlWorkspaceId,
    enrollmentId: crypto.randomUUID(),
    connectionInstanceId: crypto.randomUUID(),
    scope: `attempt-${attemptId}`,
  };
  await shared.admin`insert into enrollments
    (id,account_id,workspace_id,pubkey,status,connection_instance_id,connection_lease_expires_at,agent_capabilities)
    values (${target.enrollmentId},${owner.accountId},${controlWorkspaceId},${`ed25519:${suffix}`},
      'active',${target.connectionInstanceId},now()+interval '1 hour','{"secretFileFencing":true}'::jsonb)`;
  return { owner, target };
}

const claim = () =>
  claimConnectedSecretScopes(client.db, {
    claimId: crypto.randomUUID(),
    limit: 100,
    claimTtlMs: 300_000,
  });

test("register before dispatch, retain through offline cleanup, acknowledge only physical closure", async () => {
  const { owner, target } = await fixture(true);
  const id = await registerConnectedSecretScope(client.db, owner, target);
  expect(await registerConnectedSecretScope(client.db, owner, target)).toBe(id);
  expect((await claim()).some((row) => row.id === id)).toBe(false);
  // Completion before a closure request cannot discard the obligation.
  await completeConnectedSecretScope(client.db, owner, id);
  await requestConnectedSecretScopeClose(client.db, owner, id);
  const first = (await claim()).find((row) => row.id === id)!;
  expect(first).toMatchObject({ ...target, attempts: 1 });
  await deferConnectedSecretScope(client.db, first, 30_000);
  expect((await claim()).some((row) => row.id === id)).toBe(false);
  await expect(registerConnectedSecretScope(client.db, owner, target)).rejects.toThrow();
  await shared.admin`update connected_secret_file_scopes set retry_after=now() where id=${id}`;
  const second = (await claim()).find((row) => row.id === id)!;
  expect(second.attempts).toBe(2);
  await completeConnectedSecretScope(client.db, owner, id, first.claimId);
  expect(
    (await shared.admin`select id from connected_secret_file_scopes where id=${id}`).length,
  ).toBe(1);
  await completeConnectedSecretScope(client.db, owner, id, second.claimId);
  expect(
    (await shared.admin`select id from connected_secret_file_scopes where id=${id}`).length,
  ).toBe(0);
});

test("owner deletion cannot erase cleanup ownership; expired claims recover after process loss", async () => {
  const { owner, target } = await fixture();
  const id = await registerConnectedSecretScope(client.db, owner, target);
  await shared.admin`delete from sessions where id=${owner.sessionId}`;
  const first = (await claim()).find((row) => row.id === id)!;
  expect(first.scope).toBe(target.scope);
  await shared.admin`update connected_secret_file_scopes set claimed_at=now()-interval '10 minutes' where id=${id}`;
  const recovered = (await claim()).find((row) => row.id === id)!;
  expect(recovered.claimId).not.toBe(first.claimId);
  await completeConnectedSecretScope(client.db, owner, id, recovered.claimId);
});

test("old agents and wrong ownership fail before any cleanup scope is registered", async () => {
  const { owner, target } = await fixture();
  await shared.admin`update enrollments set agent_capabilities='{}' where id=${target.enrollmentId}`;
  await expect(registerConnectedSecretScope(client.db, owner, target)).rejects.toThrow();
  await shared.admin`update enrollments set agent_capabilities='{"secretFileFencing":true}' where id=${target.enrollmentId}`;
  await expect(
    registerConnectedSecretScope(client.db, { ...owner, attemptId: crypto.randomUUID() }, target),
  ).rejects.toThrow();
  expect(
    (
      await shared.admin`select id from connected_secret_file_scopes where enrollment_id=${target.enrollmentId}`
    ).length,
  ).toBe(0);
});

test("terminal attempt expiry closes its files even before a consumer finishes draining", async () => {
  const { owner, target } = await fixture();
  const id = await registerConnectedSecretScope(client.db, owner, target);
  // Secret files are attempt-scoped, not background-consumer-scoped. A live
  // handover retains them; logical attempt expiry makes closure eligible.
  expect((await claim()).some((row) => row.id === id)).toBe(false);
  await shared.admin`update session_turn_attempts set state='closed',outcome='interrupted_recoverable',closed_at=now() where id=${owner.attemptId}`;
  const due = (await claim()).find((row) => row.id === id)!;
  expect(due.scope).toBe(target.scope);
  await completeConnectedSecretScope(client.db, owner, id, due.claimId);
});

test("another tenant cannot close or acknowledge an obligation", async () => {
  const { owner, target } = await fixture();
  const other = await fixture();
  const id = await registerConnectedSecretScope(client.db, owner, target);
  await requestConnectedSecretScopeClose(client.db, other.owner, id);
  await completeConnectedSecretScope(client.db, other.owner, id);
  const rows =
    await shared.admin`select close_requested_at from connected_secret_file_scopes where id=${id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.close_requested_at).toBeNull();
  await requestConnectedSecretScopeClose(client.db, owner, id);
  await completeConnectedSecretScope(client.db, owner, id);
});

test("maintenance probe is read-only under FORCE RLS without exposing the ledger", async () => {
  const { owner, target } = await fixture();
  const id = await registerConnectedSecretScope(client.db, owner, target);
  await client.db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    const rows = await rawRows<{ due: boolean }>(
      tx,
      sql`select opengeni_private.connected_secret_scopes_due() as due`,
    );
    expect(rows[0]!.due).toBe(true);
  });
  await expect(
    rawRows(client.db, sql`select id from connected_secret_file_scopes where id=${id}::uuid`),
  ).rejects.toThrow();
  // The probe may over-report live owners, but the claim must not close them.
  expect((await claim()).some((row) => row.id === id)).toBe(false);
  await requestConnectedSecretScopeClose(client.db, owner, id);
  await completeConnectedSecretScope(client.db, owner, id);
});
