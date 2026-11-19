// Console agents (organization agents) under the production database setup:
// a NOSUPERUSER NOBYPASSRLS migration owner, FORCE RLS and the restricted
// runtime role. Covers the management writes in src/organization-agents.ts
// (create, drafts, publish and rollback, apply by key, management switch,
// archive, reach, tool servers and end users' logins), the visibility gate
// that hides organization rows from every other agents reader, isolation of
// the new tables, their exact runtime grants and the claim gate.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  applyOrgAgent,
  archiveOrgAgent,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  countOrgAgentMovableChats,
  createDb,
  createOrgAgent,
  createOrgToolServer,
  createSession,
  deleteEndUserToolCredential,
  deleteOrgToolServer,
  decodeEndUserToolCredentialMaterial,
  ensureExternalIdentity,
  ensureOrgAgentTestWorkspace,
  failPendingOrgAgentPublishOperation,
  findOrgAgentTestWorkspace,
  getEndUserToolCredential,
  getOrgAgent,
  getOrgToolServerWithSecrets,
  isSessionEventPersistenceError,
  listAgentsMissingFromSlack,
  listOrgAgentPublishOperations,
  listOrgAgents,
  listOrgAgentSessions,
  listOrgAgentsForWorkspace,
  listOrgAgentVersions,
  listOrgToolServers,
  OrgAgentError,
  orgAgentConfigHash,
  orgAgentReachableInWorkspace,
  publishOrgAgent,
  putEndUserToolCredential,
  rememberEndUserLabel,
  resetRememberedEndUserLabels,
  saveOrgAgentDraft,
  setOrgAgentManagement,
  submitHumanPromptInTransaction,
  updateOrgAgent,
  updateOrgToolServer,
  withOrgAgentsScope,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";
import { withSessionRlsActorContext } from "../src/database";

let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
let appSql: postgres.Sql;
const encryptionKey = crypto.getRandomValues(new Uint8Array(32));
const actor = { subjectId: "user:console-owner", label: "Owner" };

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("org-agents");
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
  appSql = postgres(shared.appUrl, { max: 2, connection: { search_path: shared.schema } });
}, 900_000);

afterAll(async () => {
  await appSql?.end().catch(() => undefined);
  await app?.close();
  await shared?.release();
}, 60_000);

/** An organization with two managed workspaces and one it does not manage. */
async function organization() {
  const accountId = crypto.randomUUID();
  const managed = crypto.randomUUID();
  const managedOther = crypto.randomUUID();
  const unmanaged = crypto.randomUUID();
  await shared.admin`insert into managed_accounts (id, name) values (${accountId}, 'Org agents')`;
  for (const [id, name] of [
    [managed, "Managed"],
    [managedOther, "Managed too"],
    [unmanaged, "Team"],
  ] as const) {
    await shared.admin`insert into workspaces (id, account_id, name) values (${id}, ${accountId}, ${name})`;
    await shared.admin`insert into workspace_inference_controls (account_id, workspace_id)
      values (${accountId}, ${id}) on conflict (workspace_id) do nothing`;
  }
  await shared.admin`insert into organization_managed_workspaces (account_id, workspace_id, source)
    values (${accountId}, ${managed}, 'console'), (${accountId}, ${managedOther}, 'api_key')`;
  return { accountId, managed, managedOther, unmanaged };
}

async function refusal(promise: Promise<unknown>): Promise<OrgAgentError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OrgAgentError) return error;
    throw error;
  }
  throw new Error("expected an OrgAgentError");
}

async function pgRejection(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const err = error as { code?: string; cause?: { code?: string } };
    return err.code ?? err.cause?.code;
  }
  throw new Error("expected the statement to fail");
}

async function auditActions(accountId: string): Promise<string[]> {
  const rows = await shared.admin<{ action: string }[]>`
    select action from organization_console_audit_events where account_id = ${accountId}
    order by created_at, id`;
  return rows.map((row) => row.action);
}

/** One runtime-role transaction in a tenancy scope, optionally with organization agents visible. */
async function asApp(
  scope: { accountId: string; workspaceId?: string | undefined; orgAgents?: boolean },
  run: (sql: postgres.TransactionSql) => PromiseLike<unknown>,
): Promise<Array<Record<string, any>>> {
  return (await appSql.begin(async (sql) => {
    await sql`select set_config('opengeni.account_id', ${scope.accountId}, true),
      set_config('opengeni.workspace_id', ${scope.workspaceId ?? ""}, true),
      set_config('opengeni.subject_id', '', true),
      set_config('opengeni.org_agents_v1', ${scope.orgAgents ? "1" : ""}, true)`;
    return await run(sql);
  })) as Array<Record<string, any>>;
}

const definition = (instructions: string, extra: Record<string, unknown> = {}) => ({
  name: "Support",
  description: "Answers customers",
  instructions,
  ...extra,
});

describe("organization agents: versions and publishing", () => {
  test("create, drafts reuse equal versions, publish, rollback and conflicts", async () => {
    const org = await organization();
    const agent = await createOrgAgent(app.db, {
      accountId: org.accountId,
      actor,
      key: "support",
      definition: definition("Be kind."),
    });
    expect(agent).toMatchObject({
      key: "support",
      name: "Support",
      managedBy: "console",
      publishedVersion: null,
      latestVersion: 1,
      published: null,
      workspaceIds: [],
    });
    expect(agent.draft).toMatchObject({ version: 1, instructions: "Be kind.", source: "console" });
    expect(agent.draft!.configHash).toBe(orgAgentConfigHash(definition("Be kind.")));

    // The key is unique in the organization.
    const taken = await refusal(
      createOrgAgent(app.db, {
        accountId: org.accountId,
        actor,
        key: "support",
        definition: definition("x"),
      }),
    );
    expect([taken.status, taken.code]).toEqual([409, "agent_key_taken"]);
    // Unknown tool servers are named.
    const missing = await refusal(
      createOrgAgent(app.db, {
        accountId: org.accountId,
        actor,
        key: "other",
        definition: definition("x", { config: { toolServers: [{ server: "nope" }] } }),
      }),
    );
    expect([missing.status, missing.code, missing.details]).toEqual([
      422,
      "tool_server_not_found",
      { missing: ["nope"] },
    ]);

    // Saving the same definition returns version 1 without writing.
    const same = await saveOrgAgentDraft(app.db, {
      accountId: org.accountId,
      agentId: agent.id,
      actor,
      expectedVersion: agent.rowVersion,
      definition: definition("Be kind."),
    });
    expect(same.created).toBe(false);
    expect(same.version.version).toBe(1);
    expect(same.agent.rowVersion).toBe(agent.rowVersion);

    const v2 = await saveOrgAgentDraft(app.db, {
      accountId: org.accountId,
      agentId: agent.id,
      actor,
      expectedVersion: agent.rowVersion,
      definition: definition("Be very kind."),
    });
    expect(v2.created).toBe(true);
    expect(v2.version.version).toBe(2);
    expect(v2.agent.latestVersion).toBe(2);

    // A stale editor gets the current row version.
    const stale = await refusal(
      saveOrgAgentDraft(app.db, {
        accountId: org.accountId,
        agentId: agent.id,
        actor,
        expectedVersion: agent.rowVersion,
        definition: definition("Lost update"),
      }),
    );
    expect([stale.status, stale.code, stale.details]).toEqual([
      409,
      "agent_version_conflict",
      { currentVersion: v2.agent.rowVersion },
    ]);

    const published = await publishOrgAgent(app.db, {
      accountId: org.accountId,
      agentId: agent.id,
      actor,
      version: 2,
      moveRunningChats: false,
      expectedVersion: v2.agent.rowVersion,
    });
    expect(published.agent.publishedVersion).toBe(2);
    expect(published.agent.published?.version).toBe(2);
    expect(published.agent.draft).toBeNull();
    expect(published.operation).toMatchObject({
      fromVersion: null,
      toVersion: 2,
      status: "succeeded",
      moveRunningChats: false,
    });
    expect(published.operation.finishedAt).not.toBeNull();

    // Rolling back with moveRunningChats leaves the move pending for the workflow.
    const rollback = await publishOrgAgent(app.db, {
      accountId: org.accountId,
      agentId: agent.id,
      actor,
      version: 1,
      moveRunningChats: true,
      expectedVersion: published.agent.rowVersion,
    });
    expect(rollback.agent.publishedVersion).toBe(1);
    expect(rollback.operation).toMatchObject({ fromVersion: 2, toVersion: 1, status: "pending" });
    expect(rollback.operation.finishedAt).toBeNull();
    // The newest version is a draft again relative to the published one.
    expect(rollback.agent.draft?.version).toBe(2);

    const unknownVersion = await refusal(
      publishOrgAgent(app.db, {
        accountId: org.accountId,
        agentId: agent.id,
        actor,
        version: 9,
        moveRunningChats: false,
        expectedVersion: rollback.agent.rowVersion,
      }),
    );
    expect([unknownVersion.status, unknownVersion.code]).toEqual([404, "agent_version_not_found"]);

    const versions = await listOrgAgentVersions(app.db, org.accountId, agent.id);
    expect(versions!.map((version) => version.version)).toEqual([2, 1]);
    expect(versions!.every((version) => version.publishedAt !== null)).toBe(true);
    const operations = await listOrgAgentPublishOperations(app.db, org.accountId, agent.id);
    expect(operations!.map((operation) => operation.status)).toEqual(["pending", "succeeded"]);

    // A move that could not start is marked failed with its reason, once.
    const failed = await failPendingOrgAgentPublishOperation(app.db, {
      accountId: org.accountId,
      operationId: rollback.operation.id,
      reason: "move_start_failed",
    });
    expect(failed).toMatchObject({ status: "failed", failureReason: "move_start_failed" });
    expect(failed!.finishedAt).not.toBeNull();
    const again = await failPendingOrgAgentPublishOperation(app.db, {
      accountId: org.accountId,
      operationId: rollback.operation.id,
      reason: "move_unavailable",
    });
    expect(again).toMatchObject({ status: "failed", failureReason: "move_start_failed" });

    const [rollbackAudit] = await shared.admin<{ detail: Record<string, unknown> }[]>`
      select detail from organization_console_audit_events
      where account_id = ${org.accountId} and action = 'agent.published'
      order by created_at desc limit 1`;
    expect(rollbackAudit!.detail).toMatchObject({ fromVersion: 2, toVersion: 1, rollback: true });
    expect(await auditActions(org.accountId)).toEqual([
      "agent.created",
      "agent.version_saved",
      "agent.published",
      "agent.published",
    ]);
    // A move that already began is left to the move workflow.
    const running = await publishOrgAgent(app.db, {
      accountId: org.accountId,
      agentId: agent.id,
      actor,
      version: 2,
      moveRunningChats: true,
      expectedVersion: rollback.agent.rowVersion,
    });
    await shared.admin`update agent_publish_operations set status = 'running'
      where id = ${running.operation.id}`;
    expect(
      await failPendingOrgAgentPublishOperation(app.db, {
        accountId: org.accountId,
        operationId: running.operation.id,
        reason: "move_start_failed",
      }),
    ).toMatchObject({ status: "running", failureReason: null });
  }, 120_000);

  test("apply by key: dry run, create, unchanged, update and publish, and 409s", async () => {
    const org = await organization();
    const apply = (
      instructions: string,
      extra: Partial<Parameters<typeof applyOrgAgent>[1]> = {},
    ) =>
      applyOrgAgent(app.db, {
        accountId: org.accountId,
        key: "triage",
        actor: { subjectId: "api_key:deploy", label: "Deploy key" },
        definition: { name: "Triage", instructions },
        publish: false,
        moveRunningChats: false,
        dryRun: false,
        ...extra,
      });

    const dry = await apply("One.", { dryRun: true, publish: true });
    expect(dry).toMatchObject({ outcome: "created", dryRun: true, version: 1, agent: null });
    expect(await listOrgAgents(app.db, org.accountId)).toEqual([]);
    expect(await auditActions(org.accountId)).toEqual([]);

    const created = await apply("One.", { publish: true });
    expect(created).toMatchObject({ outcome: "created", version: 1, published: true });
    expect(created.agent).toMatchObject({ managedBy: "code", publishedVersion: 1 });
    expect(created.agent!.published?.source).toBe("deploy");
    expect(created.configHash).toBe(dry.configHash);

    const unchanged = await apply("One.", { publish: true });
    expect(unchanged).toMatchObject({
      outcome: "unchanged",
      version: 1,
      published: true,
      operation: null,
    });
    expect(unchanged.agent!.rowVersion).toBe(created.agent!.rowVersion);

    const dryUpdate = await apply("Two.", { dryRun: true });
    expect(dryUpdate).toMatchObject({ outcome: "updated", dryRun: true, version: 2 });
    expect((await listOrgAgentVersions(app.db, org.accountId, created.agent!.id))!.length).toBe(1);

    const updated = await apply("Two.", { publish: true, moveRunningChats: true });
    expect(updated).toMatchObject({ outcome: "updated", version: 2, published: true });
    expect(updated.operation).toMatchObject({ fromVersion: 1, toVersion: 2, status: "pending" });

    // Going back to an earlier definition reuses its version.
    const back = await apply("One.", { publish: true });
    expect(back).toMatchObject({ outcome: "unchanged", version: 1, published: true });
    expect(back.operation).toMatchObject({ fromVersion: 2, toVersion: 1 });
    // The earlier move that never started will not run after this publish.
    const applyOperations = await listOrgAgentPublishOperations(
      app.db,
      org.accountId,
      created.agent!.id,
    );
    expect(
      applyOperations!.find((operation) => operation.id === updated.operation!.id),
    ).toMatchObject({ status: "failed", failureReason: "superseded" });

    // Code agents are not edited or published from Console.
    const draft = await refusal(
      saveOrgAgentDraft(app.db, {
        accountId: org.accountId,
        agentId: created.agent!.id,
        actor,
        expectedVersion: back.agent!.rowVersion,
        definition: { name: "Triage", instructions: "Edited" },
      }),
    );
    expect([draft.status, draft.code]).toEqual([409, "agent_managed_by_code"]);

    // Stale expectedVersion on apply.
    const stale = await refusal(apply("Three.", { expectedVersion: 1 }));
    expect([stale.status, stale.code]).toEqual([409, "agent_version_conflict"]);

    // After the switch to Console, deploys are refused.
    const switched = await setOrgAgentManagement(app.db, {
      accountId: org.accountId,
      agentId: created.agent!.id,
      actor,
      managedBy: "console",
      expectedVersion: back.agent!.rowVersion,
    });
    expect(switched.managedBy).toBe("console");
    const inConsole = await refusal(apply("Three."));
    expect([inConsole.status, inConsole.code]).toEqual([409, "agent_managed_in_console"]);
    const consoleDry = await refusal(apply("Three.", { dryRun: true }));
    expect(consoleDry.code).toBe("agent_managed_in_console");

    // Back to code, archive, and a deploy restores it.
    const toCode = await setOrgAgentManagement(app.db, {
      accountId: org.accountId,
      agentId: created.agent!.id,
      actor,
      managedBy: "code",
      expectedVersion: switched.rowVersion,
    });
    const archived = await archiveOrgAgent(app.db, {
      accountId: org.accountId,
      agentId: created.agent!.id,
      actor,
      expectedVersion: toCode.rowVersion,
    });
    expect(archived.archivedAt).not.toBeNull();
    expect(await listOrgAgents(app.db, org.accountId)).toEqual([]);
    expect(await getOrgAgent(app.db, org.accountId, { id: created.agent!.id })).toBeNull();
    expect(
      (await getOrgAgent(app.db, org.accountId, { key: "triage" }, { includeArchived: true }))
        ?.archivedAt,
    ).not.toBeNull();
    const restored = await apply("One.");
    expect(restored.outcome).toBe("unchanged");
    expect(restored.agent!.archivedAt).toBeNull();

    expect(await auditActions(org.accountId)).toEqual([
      "agent.published",
      "agent.deployed",
      "agent.published",
      "agent.deployed",
      "agent.published",
      "agent.deployed",
      "agent.management_changed",
      "agent.management_changed",
      "agent.archived",
      "agent.deployed",
    ]);
    const [deployActor] = await shared.admin<{ actor_subject_id: string; actor_label: string }[]>`
      select actor_subject_id, actor_label from organization_console_audit_events
      where account_id = ${org.accountId} and action = 'agent.deployed' limit 1`;
    expect(deployActor).toEqual({ actor_subject_id: "api_key:deploy", actor_label: "Deploy key" });
  }, 120_000);

  test("reach: managed workspaces and the access list; the workspace list shows published agents", async () => {
    const org = await organization();
    const agent = await createOrgAgent(app.db, {
      accountId: org.accountId,
      actor,
      key: "helper",
      definition: definition("Help."),
    });
    const reachable = (workspaceId: string) =>
      withOrgAgentsScope(app.db, { accountId: org.accountId, workspaceId }, (tx) =>
        orgAgentReachableInWorkspace(tx, {
          accountId: org.accountId,
          agentId: agent.id,
          workspaceId,
        }),
      );
    expect(await reachable(org.managed)).toBe(true);
    expect(await reachable(org.unmanaged)).toBe(false);

    // Unknown or other organizations' workspaces are refused.
    const foreign = await refusal(
      updateOrgAgent(app.db, {
        accountId: org.accountId,
        agentId: agent.id,
        actor,
        expectedVersion: agent.rowVersion,
        workspaceIds: [crypto.randomUUID()],
      }),
    );
    expect([foreign.status, foreign.code]).toEqual([422, "workspace_not_found"]);

    const withAccess = await updateOrgAgent(app.db, {
      accountId: org.accountId,
      agentId: agent.id,
      actor,
      expectedVersion: agent.rowVersion,
      workspaceIds: [org.unmanaged],
    });
    expect(withAccess.workspaceIds).toEqual([org.unmanaged]);
    expect(await reachable(org.unmanaged)).toBe(true);

    // Unpublished agents are not listed for workspaces.
    expect(
      await listOrgAgentsForWorkspace(app.db, {
        accountId: org.accountId,
        workspaceId: org.unmanaged,
      }),
    ).toEqual([]);
    const published = await publishOrgAgent(app.db, {
      accountId: org.accountId,
      agentId: agent.id,
      actor,
      version: 1,
      moveRunningChats: false,
      expectedVersion: withAccess.rowVersion,
    });
    for (const workspaceId of [org.managed, org.unmanaged]) {
      expect(
        await listOrgAgentsForWorkspace(app.db, { accountId: org.accountId, workspaceId }),
      ).toEqual([
        {
          id: agent.id,
          key: "helper",
          name: "Support",
          description: "Answers customers",
          managedBy: "console",
          publishedVersion: 1,
        },
      ]);
    }
    await updateOrgAgent(app.db, {
      accountId: org.accountId,
      agentId: agent.id,
      actor,
      expectedVersion: published.agent.rowVersion,
      workspaceIds: [],
    });
    expect(
      await listOrgAgentsForWorkspace(app.db, {
        accountId: org.accountId,
        workspaceId: org.unmanaged,
      }),
    ).toEqual([]);
    expect(await reachable(org.unmanaged)).toBe(false);
  }, 120_000);

  test("movable chats count root chats pinned to another version", async () => {
    const org = await organization();
    const agent = await createOrgAgent(app.db, {
      accountId: org.accountId,
      actor,
      key: "mover",
      definition: definition("One."),
    });
    await saveOrgAgentDraft(app.db, {
      accountId: org.accountId,
      agentId: agent.id,
      actor,
      expectedVersion: agent.rowVersion,
      definition: definition("Two."),
    });
    const chat = async (version: number) => {
      const session = await createSession(app.db, {
        accountId: org.accountId,
        workspaceId: org.managed,
        initialMessage: "",
        resources: [],
        metadata: {},
        model: "gpt-5.6-sol",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
      });
      await shared.admin`update sessions set agent_id = ${agent.id}, agent_version = ${version},
        agent_prompt_version = ${version} where id = ${session.id}`;
      return session.id;
    };
    await chat(1);
    await chat(1);
    await chat(2);
    const archivedChat = await chat(1);
    await shared.admin`update sessions set archived_at = now() where id = ${archivedChat}`;
    const count = (toVersion: number) =>
      countOrgAgentMovableChats(app.db, {
        accountId: org.accountId,
        agentId: agent.id,
        toVersion,
        workspaceIds: [org.managed, org.managedOther],
      });
    expect(await count(2)).toBe(2);
    expect(await count(1)).toBe(1);
  }, 120_000);

  test("an agent's sessions name their end user", async () => {
    resetRememberedEndUserLabels();
    const org = await organization();
    const agent = await createOrgAgent(app.db, {
      accountId: org.accountId,
      actor,
      key: "named",
      definition: definition("One."),
    });
    const identity = await ensureExternalIdentity(app.db, {
      accountId: org.accountId,
      source: "default",
      externalId: "email|66b45b2c",
    });
    await rememberEndUserLabel(app.db, {
      accountId: org.accountId,
      subjectId: identity.subjectId,
      source: "default",
      externalId: "email|66b45b2c",
      displayName: "Ingrid Nilsen",
      email: "ingrid@acme.no",
    });
    const chat = async (subjectId: string | null) => {
      const session = await createSession(app.db, {
        accountId: org.accountId,
        workspaceId: org.managed,
        initialMessage: "",
        resources: [],
        metadata: {},
        model: "gpt-5.6-sol",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
      });
      // The creator is immutable for the runtime; the fixture sets it directly.
      await shared.admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update sessions set agent_id = ${agent.id}, agent_version = 1,
          agent_prompt_version = 1 where id = ${session.id}`;
        if (subjectId)
          await tx`update sessions set created_by_subject_id = ${subjectId} where id = ${session.id}`;
      });
      return session.id;
    };
    const named = await chat(identity.subjectId);
    const internal = await chat(null);
    const listed = await listOrgAgentSessions(app.db, {
      accountId: org.accountId,
      agentId: agent.id,
      workspaceIds: [org.managed],
      limit: 10,
      cursor: null,
      includeContent: false,
    });
    const byId = new Map(listed.sessions.map((session) => [session.id, session.endUser]));
    expect(byId.get(named)).toEqual({
      subjectId: identity.subjectId,
      externalId: "email|66b45b2c",
      source: "default",
      displayName: "Ingrid Nilsen",
      email: "ingrid@acme.no",
    });
    expect(byId.get(internal)).toBeNull();
  }, 120_000);

  test("the Console test workspace is created once and marked console_test", async () => {
    const org = await organization();
    expect(await findOrgAgentTestWorkspace(app.db, org.accountId)).toBeNull();
    const create = async (
      tx: Parameters<Parameters<typeof ensureOrgAgentTestWorkspace>[1]["create"]>[0],
    ) => {
      const id = crypto.randomUUID();
      await tx.execute(drizzleSql`select set_config('opengeni.workspace_id', ${id}, true)`);
      await tx.execute(drizzleSql`insert into workspaces (id, account_id, name)
        values (${id}::uuid, ${org.accountId}::uuid, 'Console test')`);
      return { id };
    };
    const first = await ensureOrgAgentTestWorkspace(app.db, {
      accountId: org.accountId,
      actor,
      create,
    });
    expect(first.created).toBe(true);
    const again = await ensureOrgAgentTestWorkspace(app.db, {
      accountId: org.accountId,
      actor,
      create,
    });
    expect(again).toEqual({ workspaceId: first.workspaceId, created: false });
    expect(await findOrgAgentTestWorkspace(app.db, org.accountId)).toBe(first.workspaceId);
    const [marker] = await shared.admin<{ source: string }[]>`
      select source from organization_managed_workspaces where workspace_id = ${first.workspaceId}`;
    expect(marker!.source).toBe("console_test");
  }, 120_000);
});

describe("organization tool servers and end users' logins", () => {
  test("secrets are encrypted at rest and never returned", async () => {
    const org = await organization();
    const server = await createOrgToolServer(app.db, {
      accountId: org.accountId,
      actor,
      encryptionKey,
      request: {
        key: "crm",
        name: "CRM",
        url: "https://crm.example.com/mcp",
        authMode: "shared_key",
        sharedHeaders: { Authorization: "Bearer shared-secret-value" },
        oauthRefresh: {
          tokenUrl: "https://crm.example.com/token",
          clientId: "client",
          clientSecret: "client-secret-value",
        },
      },
    });
    expect(server).toMatchObject({
      key: "crm",
      hasSharedKey: true,
      sharedHeaderNames: ["Authorization"],
      oauthRefresh: {
        tokenUrl: "https://crm.example.com/token",
        clientId: "client",
        hasClientSecret: true,
      },
    });
    const listed = await listOrgToolServers(app.db, org.accountId);
    for (const value of [server, listed]) {
      const text = JSON.stringify(value);
      expect(text).not.toContain("shared-secret-value");
      expect(text).not.toContain("client-secret-value");
    }
    const [stored] = await shared.admin<{ headers: string; oauth: string }[]>`
      select shared_headers_encrypted as headers, oauth_refresh::text as oauth
      from organization_tool_servers where account_id = ${org.accountId}`;
    expect(stored!.headers).not.toContain("shared-secret-value");
    expect(stored!.oauth).not.toContain("client-secret-value");
    const secrets = await getOrgToolServerWithSecrets(app.db, {
      accountId: org.accountId,
      key: "crm",
      encryptionKey,
    });
    expect(secrets!.sharedHeaders).toEqual({ Authorization: "Bearer shared-secret-value" });
    expect(secrets!.oauthRefresh?.clientSecret).toBe("client-secret-value");

    // A shared key belongs only on a shared_key server.
    const invalid = await refusal(
      createOrgToolServer(app.db, {
        accountId: org.accountId,
        actor,
        encryptionKey,
        request: {
          key: "docs",
          name: "Docs",
          url: "https://docs.example.com/mcp",
          authMode: "per_user",
          sharedHeaders: { Authorization: "x" },
        },
      }),
    );
    expect([invalid.status, invalid.code]).toEqual([422, "tool_server_invalid"]);
    const taken = await refusal(
      createOrgToolServer(app.db, {
        accountId: org.accountId,
        actor,
        encryptionKey,
        request: { key: "crm", name: "CRM", url: "https://crm.example.com/mcp", authMode: "none" },
      }),
    );
    expect([taken.status, taken.code]).toEqual([409, "tool_server_key_taken"]);

    // Leaving shared_key drops the key; the OAuth client secret stays for the same client.
    const perUser = await updateOrgToolServer(app.db, {
      accountId: org.accountId,
      key: "crm",
      actor,
      encryptionKey,
      request: {
        expectedVersion: server.rowVersion,
        authMode: "per_user",
        oauthRefresh: { tokenUrl: "https://crm.example.com/token2", clientId: "client" },
      },
    });
    expect(perUser).toMatchObject({
      authMode: "per_user",
      hasSharedKey: false,
      sharedHeaderNames: [],
      oauthRefresh: { tokenUrl: "https://crm.example.com/token2", hasClientSecret: true },
    });
    const stale = await refusal(
      updateOrgToolServer(app.db, {
        accountId: org.accountId,
        key: "crm",
        actor,
        encryptionKey,
        request: { expectedVersion: server.rowVersion, name: "Old" },
      }),
    );
    expect([stale.status, stale.code]).toEqual([409, "agent_version_conflict"]);
    const after = await getOrgToolServerWithSecrets(app.db, {
      accountId: org.accountId,
      key: "crm",
      encryptionKey,
    });
    expect(after!.sharedHeaders).toBeNull();
    expect(after!.oauthRefresh?.clientSecret).toBe("client-secret-value");

    // Audit details never carry secret values.
    const audits = await shared.admin<{ action: string; detail: unknown }[]>`
      select action, detail from organization_console_audit_events
      where account_id = ${org.accountId} order by created_at`;
    expect(audits.map((row) => row.action)).toEqual(["tool_server.created", "tool_server.updated"]);
    expect(JSON.stringify(audits)).not.toContain("secret-value");
  }, 120_000);

  test("end users' logins: managed workspaces only, metadata only, per workspace", async () => {
    const org = await organization();
    await createOrgToolServer(app.db, {
      accountId: org.accountId,
      actor,
      encryptionKey,
      request: {
        key: "crm",
        name: "CRM",
        url: "https://crm.example.com/mcp",
        authMode: "per_user",
      },
    });
    const target = (workspaceId: string) => ({
      accountId: org.accountId,
      workspaceId,
      endUserSubjectId: "external_user:customer-1",
      toolServerKey: "crm",
    });
    const notManaged = await refusal(
      putEndUserToolCredential(app.db, {
        ...target(org.unmanaged),
        actor,
        encryptionKey,
        credential: { kind: "headers", headers: { Authorization: "Bearer end-user-token" } },
      }),
    );
    expect([notManaged.status, notManaged.code]).toEqual([409, "workspace_not_managed"]);
    const noServer = await refusal(
      getEndUserToolCredential(app.db, { ...target(org.managed), toolServerKey: "nope" }),
    );
    expect([noServer.status, noServer.code]).toEqual([404, "tool_server_not_found"]);

    const written = await putEndUserToolCredential(app.db, {
      ...target(org.managed),
      actor,
      encryptionKey,
      credential: {
        kind: "oauth",
        accessToken: "end-user-token",
        refreshToken: "end-user-refresh",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    });
    expect(written).toMatchObject({
      toolServerKey: "crm",
      kind: "oauth",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(JSON.stringify(written)).not.toContain("end-user");
    const read = await getEndUserToolCredential(app.db, target(org.managed));
    expect(read).toMatchObject({ kind: "oauth" });
    expect(JSON.stringify(read)).not.toContain("end-user-token");
    // Another managed workspace has its own store.
    expect(await getEndUserToolCredential(app.db, target(org.managedOther))).toBeNull();

    const [row] = await shared.admin<{ material: string }[]>`
      select material_encrypted as material from end_user_tool_credentials
      where account_id = ${org.accountId}`;
    expect(row!.material).not.toContain("end-user-token");
    expect(decodeEndUserToolCredentialMaterial(encryptionKey, row!.material)).toEqual({
      kind: "oauth",
      accessToken: "end-user-token",
      refreshToken: "end-user-refresh",
      tokenType: "Bearer",
    });

    // The runtime role cannot read the login from another workspace's context.
    const crossWorkspace = await asApp(
      { accountId: org.accountId, workspaceId: org.managedOther },
      (sql) => sql`select count(*)::int as count from end_user_tool_credentials`,
    );
    expect(crossWorkspace[0]!.count).toBe(0);
    const ownWorkspace = await asApp(
      { accountId: org.accountId, workspaceId: org.managed },
      (sql) => sql`select count(*)::int as count from end_user_tool_credentials`,
    );
    expect(ownWorkspace[0]!.count).toBe(1);
    // The account context sees the organization's logins (to delete them
    // across workspaces); another organization sees none.
    const accountContext = await asApp(
      { accountId: org.accountId },
      (sql) => sql`select count(*)::int as count from end_user_tool_credentials`,
    );
    expect(accountContext[0]!.count).toBe(1);
    const otherOrganization = await asApp(
      { accountId: crypto.randomUUID() },
      (sql) => sql`select count(*)::int as count from end_user_tool_credentials`,
    );
    expect(otherOrganization[0]!.count).toBe(0);

    expect(await deleteEndUserToolCredential(app.db, { ...target(org.managed), actor })).toBe(true);
    expect(await deleteEndUserToolCredential(app.db, { ...target(org.managed), actor })).toBe(
      false,
    );
    expect(await getEndUserToolCredential(app.db, target(org.managed))).toBeNull();

    // Deleting the server deletes its logins.
    await putEndUserToolCredential(app.db, {
      ...target(org.managed),
      actor,
      encryptionKey,
      credential: { kind: "headers", headers: { Authorization: "Bearer again" } },
    });
    expect(await deleteOrgToolServer(app.db, { accountId: org.accountId, key: "crm", actor })).toBe(
      true,
    );
    const [left] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from end_user_tool_credentials where account_id = ${org.accountId}`;
    expect(left!.count).toBe(0);
    expect(await auditActions(org.accountId)).toEqual([
      "tool_server.created",
      "tool_credential.written",
      "tool_credential.deleted",
      "tool_credential.written",
      "tool_server.deleted",
    ]);
  }, 120_000);

  test("moving a tool server to another origin drops its secrets and end users' logins", async () => {
    const org = await organization();
    const created = await createOrgToolServer(app.db, {
      accountId: org.accountId,
      actor,
      encryptionKey,
      request: {
        key: "crm",
        name: "CRM",
        url: "https://crm.example.com/mcp",
        authMode: "shared_key",
        sharedHeaders: { Authorization: "Bearer shared" },
        oauthRefresh: {
          tokenUrl: "https://crm.example.com/token",
          clientId: "client",
          clientSecret: "client-secret",
        },
      },
    });
    const login = (workspaceId: string, kind: "headers" | "oauth") =>
      putEndUserToolCredential(app.db, {
        accountId: org.accountId,
        workspaceId,
        endUserSubjectId: "external_user:customer-1",
        toolServerKey: "crm",
        actor,
        encryptionKey,
        credential:
          kind === "headers"
            ? { kind, headers: { Authorization: "Bearer end-user" } }
            : { kind, accessToken: "end-user", refreshToken: "refresh" },
      });
    await login(org.managed, "oauth");
    await login(org.managedOther, "headers");
    const logins = async () =>
      (
        await shared.admin<{ kind: string }[]>`
          select kind from end_user_tool_credentials where account_id = ${org.accountId}
          order by kind`
      ).map((row) => row.kind);
    const secrets = () =>
      getOrgToolServerWithSecrets(app.db, { accountId: org.accountId, key: "crm", encryptionKey });
    let rowVersion = created.rowVersion;
    const update = async (
      request: Omit<Parameters<typeof updateOrgToolServer>[1]["request"], "expectedVersion">,
    ) => {
      const updated = await updateOrgToolServer(app.db, {
        accountId: org.accountId,
        key: "crm",
        actor,
        encryptionKey,
        request: { expectedVersion: rowVersion, ...request },
      });
      rowVersion = updated.rowVersion;
      return updated;
    };

    // Same origins: everything stays.
    await update({ name: "CRM 2", url: "https://crm.example.com/v2/mcp" });
    expect(await logins()).toEqual(["headers", "oauth"]);
    expect((await secrets())!.sharedHeaders).toEqual({ Authorization: "Bearer shared" });

    // OAuth refresh at another origin: the client secret and OAuth logins go.
    const tokenMoved = await update({
      oauthRefresh: { tokenUrl: "https://login.other.example/token", clientId: "client" },
    });
    expect(tokenMoved.oauthRefresh).toMatchObject({ hasClientSecret: false });
    expect(tokenMoved.hasSharedKey).toBe(true);
    expect(await logins()).toEqual(["headers"]);

    // The server at another origin: the shared key and every login go.
    await login(org.managed, "oauth");
    const moved = await update({ url: "https://crm.other.example/mcp" });
    expect(moved).toMatchObject({ hasSharedKey: false, sharedHeaderNames: [] });
    expect((await secrets())!.sharedHeaders).toBeNull();
    expect(await logins()).toEqual([]);

    // A new key in the same request is kept; re-supplied client secrets too.
    await login(org.managed, "headers");
    const resupplied = await update({
      url: "https://crm.example.com/mcp",
      sharedHeaders: { Authorization: "Bearer new" },
      oauthRefresh: {
        tokenUrl: "https://crm.example.com/token",
        clientId: "client",
        clientSecret: "new-secret",
      },
    });
    expect(resupplied).toMatchObject({
      hasSharedKey: true,
      oauthRefresh: { hasClientSecret: true },
    });
    expect((await secrets())!.sharedHeaders).toEqual({ Authorization: "Bearer new" });
    expect(await logins()).toEqual([]);

    const audits = await shared.admin<{ detail: Record<string, unknown> }[]>`
      select detail from organization_console_audit_events
      where account_id = ${org.accountId} and action = 'tool_server.updated'
      order by created_at, id`;
    const fields = [
      "urlOriginChanged",
      "tokenUrlOriginChanged",
      "sharedKeyDropped",
      "clientSecretDropped",
      "endUserLoginsRemoved",
    ];
    const moves = audits.map(
      ({ detail }): Record<string, unknown> =>
        Object.fromEntries(
          fields
            .filter((field) => detail[field] !== undefined)
            .map((field) => [field, detail[field]]),
        ),
    );
    expect(moves).toEqual([
      {},
      { tokenUrlOriginChanged: true, clientSecretDropped: true, endUserLoginsRemoved: 1 },
      { urlOriginChanged: true, sharedKeyDropped: true, endUserLoginsRemoved: 2 },
      { urlOriginChanged: true, tokenUrlOriginChanged: true, endUserLoginsRemoved: 1 },
    ]);
    for (const value of ["client-secret", "new-secret", "Bearer"]) {
      expect(JSON.stringify(audits)).not.toContain(value);
    }
  }, 120_000);
});

describe("organization agents: visibility gate, isolation and grants", () => {
  test("organization rows are invisible without the opt-in setting", async () => {
    const org = await organization();
    const agent = await createOrgAgent(app.db, {
      accountId: org.accountId,
      actor,
      key: "hidden",
      definition: definition("Hidden."),
    });
    for (const workspaceId of [undefined, org.managed]) {
      const hidden = await asApp(
        { accountId: org.accountId, workspaceId },
        (sql) =>
          sql`select (select count(*)::int from agents where scope = 'organization') as agents,
          (select count(*)::int from agent_revisions where workspace_id is null) as revisions`,
      );
      expect(hidden[0]).toEqual({ agents: 0, revisions: 0 });
      const visible = await asApp(
        { accountId: org.accountId, workspaceId, orgAgents: true },
        (sql) =>
          sql`select (select count(*)::int from agents where scope = 'organization') as agents,
          (select count(*)::int from agent_revisions where workspace_id is null) as revisions`,
      );
      expect(visible[0]).toEqual({ agents: 1, revisions: 1 });
    }
    // Writes are refused without the setting too.
    const write = await pgRejection(
      asApp(
        { accountId: org.accountId },
        (sql) =>
          sql`insert into agents (account_id, workspace_id, scope, agent_key, visibility, name, name_key,
            origin, current_revision)
          values (${org.accountId}, null, 'organization', 'sneaky', 'workspace', 'Sneaky', 'sneaky',
            'app', 1)`,
      ),
    );
    expect(write).toBe("42501");

    // Slack placement never offers it.
    const connectionId = crypto.randomUUID();
    await shared.admin`insert into connections
      (id, account_id, workspace_id, provider_domain, kind, status, credential_encrypted)
      values (${connectionId}, ${org.accountId}, ${org.managed}, 'slack.com', 'app_install', 'active',
        '\\x00'::bytea)`;
    const missing = await listAgentsMissingFromSlack(
      app.db,
      { accountId: org.accountId, workspaceId: org.managed },
      { connectionId },
    );
    expect(missing.map((entry) => entry.id)).not.toContain(agent.id);
    // The organization's directory read (Teams routing reads agents this way) does not see it either.
    const directory = await asApp(
      { accountId: org.accountId },
      (sql) =>
        sql`select id::text as id from agents where account_id = ${org.accountId} and visibility = 'workspace'`,
    );
    expect(directory.map((row) => row.id)).not.toContain(agent.id);
  }, 120_000);

  test("each new table is isolated per organization", async () => {
    const a = await organization();
    const b = await organization();
    for (const org of [a, b]) {
      const agent = await createOrgAgent(app.db, {
        accountId: org.accountId,
        actor,
        key: "shared-key",
        definition: definition("x"),
        workspaceIds: [org.unmanaged],
      });
      await publishOrgAgent(app.db, {
        accountId: org.accountId,
        agentId: agent.id,
        actor,
        version: 1,
        moveRunningChats: false,
        expectedVersion: agent.rowVersion,
      });
      await createOrgToolServer(app.db, {
        accountId: org.accountId,
        actor,
        encryptionKey,
        request: {
          key: "crm",
          name: "CRM",
          url: "https://crm.example.com/mcp",
          authMode: "per_user",
        },
      });
      await putEndUserToolCredential(app.db, {
        accountId: org.accountId,
        workspaceId: org.managed,
        endUserSubjectId: "external_user:same",
        toolServerKey: "crm",
        actor,
        encryptionKey,
        credential: { kind: "headers", headers: { Authorization: "Bearer x" } },
      });
    }
    const tables = [
      "agents",
      "agent_revisions",
      "organization_tool_servers",
      "end_user_tool_credentials",
      "agent_workspace_access",
      "agent_publish_operations",
    ];
    for (const workspaceId of [undefined, a.managed]) {
      const counts = await asApp(
        { accountId: a.accountId, workspaceId, orgAgents: true },
        async (sql) => {
          const result: Record<string, number> = {};
          for (const table of tables) {
            const [row] = await sql.unsafe<{ count: number }[]>(
              `select count(*)::int as count from ${table} where account_id = $1`,
              [b.accountId],
            );
            result[table] = row!.count;
          }
          return result;
        },
      );
      expect(counts as unknown).toEqual(Object.fromEntries(tables.map((table) => [table, 0])));
    }
    const [bServer] = await shared.admin<{ id: string }[]>`
      select id from organization_tool_servers where account_id = ${b.accountId}`;
    const [bAgent] = await shared.admin<{ id: string }[]>`
      select id from agents where account_id = ${b.accountId} and scope = 'organization'`;
    const foreignWrites = [
      (sql: postgres.TransactionSql) =>
        sql`insert into organization_tool_servers (account_id, server_key, name, url, auth_mode)
          values (${b.accountId}, 'evil', 'Evil', 'https://evil.example.com', 'none')`,
      (sql: postgres.TransactionSql) =>
        sql`insert into end_user_tool_credentials (account_id, workspace_id, end_user_subject_id,
            tool_server_id, kind, material_encrypted)
          values (${b.accountId}, ${b.managed}, 'external_user:x', ${bServer!.id}, 'headers', 'x')`,
      (sql: postgres.TransactionSql) =>
        sql`insert into agent_workspace_access (account_id, agent_id, workspace_id)
          values (${b.accountId}, ${bAgent!.id}, ${b.unmanaged})`,
      (sql: postgres.TransactionSql) =>
        sql`insert into agent_publish_operations (account_id, agent_id, to_revision, status)
          values (${b.accountId}, ${bAgent!.id}, 1, 'succeeded')`,
      (sql: postgres.TransactionSql) =>
        sql`insert into agents (account_id, workspace_id, scope, agent_key, visibility, name, name_key,
            origin, current_revision)
          values (${b.accountId}, null, 'organization', 'evil', 'workspace', 'Evil', 'evil', 'app', 1)`,
    ];
    for (const write of foreignWrites) {
      expect(
        await pgRejection(
          asApp({ accountId: a.accountId, workspaceId: a.managed, orgAgents: true }, write),
        ),
      ).toBe("42501");
    }
    // Organization B's agent is not reachable from A's workspace, and A sees only its own.
    expect(
      (
        await listOrgAgentsForWorkspace(app.db, {
          accountId: a.accountId,
          workspaceId: a.unmanaged,
        })
      ).map((agent) => agent.key),
    ).toEqual(["shared-key"]);
    expect(
      await listOrgAgentsForWorkspace(app.db, { accountId: a.accountId, workspaceId: b.unmanaged }),
    ).toEqual([]);
    expect(await getOrgAgent(app.db, a.accountId, { id: bAgent!.id })).toBeNull();
  }, 120_000);

  test("runtime grants are exact", async () => {
    const rows = await shared.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
      where grantee = 'opengeni_app' and table_schema = ${shared.schema}
        and table_name in ('agent_revisions', 'organization_tool_servers', 'end_user_tool_credentials',
          'agent_workspace_access', 'agent_publish_operations')
      order by table_name, privilege_type`;
    const grants: Record<string, string[]> = {};
    for (const row of rows) (grants[row.table_name] ??= []).push(row.privilege_type);
    expect(grants).toEqual({
      agent_publish_operations: ["INSERT", "SELECT", "UPDATE"],
      agent_revisions: ["INSERT", "SELECT"],
      agent_workspace_access: ["DELETE", "INSERT", "SELECT", "UPDATE"],
      end_user_tool_credentials: ["DELETE", "INSERT", "SELECT", "UPDATE"],
      organization_tool_servers: ["DELETE", "INSERT", "SELECT", "UPDATE"],
    });
    const forced = await shared.admin<{ relname: string; forced: boolean; enabled: boolean }[]>`
      select c.relname, c.relforcerowsecurity as forced, c.relrowsecurity as enabled
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${shared.schema} and c.relname in ('organization_tool_servers',
        'end_user_tool_credentials', 'agent_workspace_access', 'agent_publish_operations')
      order by c.relname`;
    expect(forced.every((row) => row.forced && row.enabled)).toBe(true);
    expect(forced.length).toBe(4);
  }, 60_000);
});

describe("organization agent chats: claim gate", () => {
  test("a worker without the organization agent protocol cannot claim a pinned chat", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(app.db, {
      accountExternalSource: "test",
      accountExternalId: suffix,
      accountName: "org agents",
      workspaceExternalSource: "test",
      workspaceExternalId: suffix,
      workspaceName: "org agents",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const accountId = grant.accountId;
    const workspaceId = grant.workspaceId!;
    const subjectId = grant.subjectId;
    const agent = await createOrgAgent(app.db, {
      accountId,
      actor,
      key: "pinned",
      definition: definition("Pinned."),
    });
    const chat = async (pinned: boolean) => {
      const session = await withSessionRlsActorContext({ subjectId }, () =>
        createSession(app.db, {
          accountId,
          workspaceId,
          initialMessage: "",
          resources: [],
          metadata: {},
          model: "scripted-model",
          reasoningEffort: "low",
          latencyMode: "standard",
          sandboxBackend: "none",
        }),
      );
      if (pinned) {
        await shared.admin`update sessions set agent_id = ${agent.id}, agent_version = 1,
          agent_prompt_version = 1 where id = ${session.id}`;
      }
      await withWorkspaceSubjectSessionActivityRls(app.db, workspaceId, subjectId, (db) =>
        submitHumanPromptInTransaction(db, {
          accountId,
          workspaceId,
          sessionId: session.id,
          subjectId,
          actor: { type: "human", subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "work",
          resources: [],
          reasoningEffort: "low",
          reasoningEffortFallback: "low",
          source: "user",
        }),
      );
      return session.id;
    };
    const claimInput = (sessionId: string) => ({
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" as const },
      agentInstructionsProtocol: 1 as const,
    });

    const pinned = await chat(true);
    const refused = await claimSessionWorkForAttempt(app.db, workspaceId, claimInput(pinned)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isSessionEventPersistenceError(refused)).toBe(true);
    if (!isSessionEventPersistenceError(refused)) throw refused;
    expect(refused.details).toMatchObject({ sqlState: "55000" });
    const [state] = await shared.admin<{ attempts: number; status: string }[]>`
      select s.status, (select count(*)::int from session_turn_attempts a where a.session_id = s.id) as attempts
      from sessions s where s.id = ${pinned}`;
    expect(state!.attempts).toBe(0);
    expect(state!.status).not.toBe("failed");

    // The worker declares the protocol through the claim itself, as
    // apps/worker/src/activities/agent-turn/claim.ts does: the claim sets the
    // setting from `orgAgentProtocol` for its own transaction (replacing any
    // value an enclosing transaction left), so the same work is claimed.
    expect(
      await claimSessionWorkForAttempt(app.db, workspaceId, {
        ...claimInput(pinned),
        orgAgentProtocol: 1,
      }),
    ).toMatchObject({ action: "claimed" });

    // Chats without an organization agent are unaffected.
    const plain = await chat(false);
    expect(await claimSessionWorkForAttempt(app.db, workspaceId, claimInput(plain))).toMatchObject({
      action: "claimed",
    });
  }, 180_000);
});
