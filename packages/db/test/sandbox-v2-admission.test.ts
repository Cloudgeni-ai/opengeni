import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  acquireLease,
  bootstrapWorkspace,
  configureSandboxV2AdmissionPolicy,
  createDb,
  createSession,
  createSessionWithIdempotencyKeyResult,
  findSandboxMachine,
  getSession,
  nestedPostgresSqlState,
  updateWorkspaceSettings,
  type SessionCreateInput,
  readSandboxSessionEngineRoute,
} from "../src";

let fixture: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
const off = { enabled: false, qualifiedBackends: new Set<string>() };
const on = { enabled: true, qualifiedBackends: new Set(["docker"]) };
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("sandbox-v2-admission");
  if (!acquired) throw new Error("Sandbox admission requires disposable PostgreSQL");
  fixture = acquired;
  client = createDb(fixture.appUrl);
}, 180_000);
afterEach(() => configureSandboxV2AdmissionPolicy(client.db, off));
afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 60_000);

async function workspace() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Synthetic sandbox admission",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Synthetic sandbox admission",
    subjectId: `subject-${suffix}`,
  });
  return access.workspaceGrants[0]!;
}
type Grant = Awaited<ReturnType<typeof workspace>>;
function input(grant: Grant, options: Partial<SessionCreateInput> = {}): SessionCreateInput {
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "synthetic",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "docker",
    ...options,
  };
}
async function machine(grant: Grant, sandboxGroupId: string) {
  return findSandboxMachine(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sandboxGroupId,
  });
}

describe("sandbox v2 engine admission", () => {
  test("default-off host and a second unconfigured DB service remain legacy", async () => {
    const grant = await workspace();
    await updateWorkspaceSettings(client.db, grant.workspaceId!, { sandboxV2Enabled: true });
    const legacy = await createSession(client.db, input(grant));
    expect(await machine(grant, legacy.sandboxGroupId)).toBeNull();
    expect(
      await readSandboxSessionEngineRoute(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: legacy.id,
      }),
    ).toEqual({
      engine: "legacy",
      sandboxGroupId: legacy.sandboxGroupId,
    });
    configureSandboxV2AdmissionPolicy(client.db, on);
    const admitted = await createSession(client.db, input(grant));
    expect((await machine(grant, admitted.sandboxGroupId))?.provider).toBe("docker");
    const other = createDb(fixture.appUrl);
    try {
      const unconfigured = await createSession(other.db, input(grant));
      expect(await machine(grant, unconfigured.sandboxGroupId)).toBeNull();
    } finally {
      await other.close();
    }
  }, 60_000);

  test("fresh admission requires literal workspace opt-in and server qualification", async () => {
    const grant = await workspace();
    const qualified = new Set(["docker"]);
    configureSandboxV2AdmissionPolicy(client.db, { enabled: true, qualifiedBackends: qualified });
    qualified.clear(); // Caller mutation cannot revoke the installed policy.
    const missing = await createSession(client.db, input(grant));
    expect(await machine(grant, missing.sandboxGroupId)).toBeNull();
    await fixture.admin`update workspaces set settings = jsonb_set(settings,'{sandboxV2Enabled}','"true"'::jsonb)
      where id=${grant.workspaceId!}::uuid`;
    const malformed = await createSession(client.db, input(grant));
    expect(await machine(grant, malformed.sandboxGroupId)).toBeNull();
    await updateWorkspaceSettings(client.db, grant.workspaceId!, { sandboxV2Enabled: true });
    const admitted = await createSession(client.db, input(grant));
    const projection = await machine(grant, admitted.sandboxGroupId);
    expect(projection).toMatchObject({
      version: 0,
      state: "absent",
      target: "suspended",
      instance: null,
      disk: null,
      demands: [],
      transition: null,
    });
    configureSandboxV2AdmissionPolicy(client.db, { enabled: true, qualifiedBackends: new Set() });
    const unqualified = await createSession(client.db, input(grant));
    expect(await machine(grant, unqualified.sandboxGroupId)).toBeNull();
  }, 60_000);

  test("concurrent keyed creation commits exactly one session and machine", async () => {
    const grant = await workspace();
    await updateWorkspaceSettings(client.db, grant.workspaceId!, { sandboxV2Enabled: true });
    configureSandboxV2AdmissionPolicy(client.db, on);
    let wins = 0;
    const createIdempotencyKey = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        createSessionWithIdempotencyKeyResult(client.db, {
          ...input(grant, {
            beforeCreateCommit: async (_tx, _id, context) => {
              if (context?.created) wins++;
            },
          }),
          createIdempotencyKey,
        }),
      ),
    );
    const successes = results.filter((result) => !result.denied);
    expect(successes).toHaveLength(8);
    expect(new Set(successes.map((result) => result.session.id)).size).toBe(1);
    expect(successes.filter((result) => result.created)).toHaveLength(1);
    expect(wins).toBe(1);
    const session = successes[0]!.session;
    expect((await machine(grant, session.sandboxGroupId))?.version).toBe(0);
    const [count] = await fixture.admin<{ count: number }[]>`select count(*)::int as count
      from sandbox_v2_machines where workspace_id=${grant.workspaceId!}::uuid`;
    expect(count?.count).toBe(1);
  }, 60_000);

  test("flag changes and joins preserve each existing group's recorded choice", async () => {
    const grant = await workspace();
    const legacy = await createSession(client.db, input(grant));
    await updateWorkspaceSettings(client.db, grant.workspaceId!, { sandboxV2Enabled: true });
    configureSandboxV2AdmissionPolicy(client.db, on);
    const legacyJoin = await createSession(
      client.db,
      input(grant, { sandboxGroupId: legacy.sandboxGroupId }),
    );
    expect(await machine(grant, legacyJoin.sandboxGroupId)).toBeNull();
    const createIdempotencyKey = crypto.randomUUID();
    const v2 = await createSession(client.db, input(grant, { createIdempotencyKey }));
    const recorded = await machine(grant, v2.sandboxGroupId);
    expect(recorded).not.toBeNull();
    configureSandboxV2AdmissionPolicy(client.db, off);
    await updateWorkspaceSettings(client.db, grant.workspaceId!, { sandboxV2Enabled: false });
    expect(
      await readSandboxSessionEngineRoute(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: v2.id,
      }),
    ).toEqual({
      engine: "machine-v2",
      sandboxGroupId: v2.sandboxGroupId,
      machineId: recorded!.id,
      provider: "docker",
    });
    const unrelated = await workspace();
    await expect(
      readSandboxSessionEngineRoute(client.db, {
        accountId: unrelated.accountId,
        workspaceId: unrelated.workspaceId!,
        sessionId: v2.id,
      }),
    ).rejects.toThrow("Sandbox session route unavailable");
    const v2Join = await createSession(
      client.db,
      input(grant, { sandboxGroupId: v2.sandboxGroupId }),
    );
    expect(await machine(grant, v2Join.sandboxGroupId)).toEqual(recorded);
    const replay = await createSession(
      client.db,
      input(grant, { requestedSessionId: v2.id, createIdempotencyKey }),
    );
    expect(replay.id).toBe(v2.id);
    expect(await machine(grant, replay.sandboxGroupId)).toEqual(recorded);
    const later = await createSession(client.db, input(grant));
    expect(await machine(grant, later.sandboxGroupId)).toBeNull();
  }, 60_000);

  test("a failed create rolls back machine admission with the session", async () => {
    const grant = await workspace();
    await updateWorkspaceSettings(client.db, grant.workspaceId!, { sandboxV2Enabled: true });
    configureSandboxV2AdmissionPolicy(client.db, on);
    const requestedSessionId = crypto.randomUUID();
    await expect(
      createSession(
        client.db,
        input(grant, {
          requestedSessionId,
          beforeCreateCommit: async () => {
            throw new Error("synthetic linkage failure");
          },
        }),
      ),
    ).rejects.toThrow("synthetic linkage failure");
    expect(await machine(grant, requestedSessionId)).toBeNull();
    expect(await getSession(client.db, grant.workspaceId!, requestedSessionId)).toBeNull();
    const recovered = await createSession(client.db, input(grant, { requestedSessionId }));
    expect((await machine(grant, recovered.sandboxGroupId))?.version).toBe(0);
  }, 60_000);

  test("retained cold legacy authority prevents fresh v2 admission", async () => {
    const grant = await workspace();
    await updateWorkspaceSettings(client.db, grant.workspaceId!, { sandboxV2Enabled: true });
    configureSandboxV2AdmissionPolicy(client.db, on);
    const requestedSessionId = crypto.randomUUID();
    await fixture.admin`insert into sandbox_leases
      (account_id,workspace_id,sandbox_group_id,liveness,backend,os,expires_at)
      values (${grant.accountId}::uuid,${grant.workspaceId!}::uuid,${requestedSessionId}::uuid,
        'cold','docker','linux',now()+interval '1 minute')`;
    const legacy = await createSession(client.db, input(grant, { requestedSessionId }));
    expect(await machine(grant, legacy.sandboxGroupId)).toBeNull();
    const v2 = await createSession(client.db, input(grant));
    let failure: unknown;
    try {
      await acquireLease(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sandboxGroupId: v2.sandboxGroupId,
        backend: "docker",
        kind: "direct",
        holderId: crypto.randomUUID(),
        leaseTtlMs: 1000,
      });
    } catch (error) {
      failure = error;
    }
    expect(nestedPostgresSqlState(failure)).toBe("23514");
    const [count] = await fixture.admin<{ count: number }[]>`select count(*)::int as count
      from sandbox_leases where workspace_id=${grant.workspaceId!}::uuid and sandbox_group_id=${v2.sandboxGroupId}::uuid`;
    expect(count?.count).toBe(0);
  }, 60_000);

  test("host and Connected Machine backends retain their existing path", async () => {
    const grant = await workspace();
    await updateWorkspaceSettings(client.db, grant.workspaceId!, { sandboxV2Enabled: true });
    configureSandboxV2AdmissionPolicy(client.db, {
      enabled: true,
      qualifiedBackends: new Set(["none", "local", "selfhosted"]),
    });
    for (const sandboxBackend of ["none", "local", "selfhosted"] as const) {
      const session = await createSession(client.db, input(grant, { sandboxBackend }));
      expect(await machine(grant, session.sandboxGroupId)).toBeNull();
    }
  }, 60_000);
});
