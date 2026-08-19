// Migration 0280: connection-use audit facts and variable-set audit events
// carry the accepted authority attribution, and variable-set denials are
// recorded by the application in a fresh transaction.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  claimSessionWorkForAttempt,
  readVariableSetSecretAtomically,
  VariableSetSecretReadAuthorityError,
  createDb,
  createSession,
  getVariableSetValuesForRun,
  initializeSessionStartAtomically,
  resolveAcceptedConnectionUse,
  type Database,
  type DbClient,
} from "../src";

const migrationUrl = new URL(
  "../drizzle/0280_connection_and_variable_set_audit_attribution.sql",
  import.meta.url,
);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0280-audit-attribution");
  if (!shared) {
    available = false;
    if (requireRealDatabase) throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no database");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
});

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

type Fixture = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

async function claimedTurnFixture(initiatingHuman?: string): Promise<Fixture> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('audit-attribution') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'audit-attribution-workspace') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const session = await createSession(db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    initialMessage: "attribute this use",
    resources: [],
    metadata: {},
    ...(initiatingHuman
      ? { createdBy: { kind: "subject" as const, subjectId: initiatingHuman } }
      : {}),
    ...(initiatingHuman ? { subjectId: initiatingHuman } : {}),
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, workspace!.id, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `audit-attribution-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`could not claim fixture: ${claim.reason}`);
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
  };
}

describe("migration 0280 audit attribution", () => {
  test("declares one rolling attribution protocol", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    for (const column of [
      '"initiator_kind" text',
      '"initiating_human_subject_id" text',
      '"authority_epoch" integer',
      '"authority_visibility" text',
      '"authority_owner_organization_membership_id" uuid',
    ]) {
      expect(source).toContain(column);
    }
    // Audit rows are immutable evidence; no FK may block a membership
    // lifecycle or retention operation.
    expect(source).not.toContain("REFERENCES");
    expect(source).toContain("NOT VALID");
    expect(source).toContain("VALIDATE CONSTRAINT");
    expect(source).toContain("CREATE OR REPLACE FUNCTION resolve_accepted_connection_use(");
    expect(source).toContain(
      "CREATE OR REPLACE FUNCTION materialize_scoped_variable_set_for_attempt(",
    );
    expect(source).toContain("read_scoped_variable_set_secret(");
    // Attribution is copied from rows the same transaction locked, verbatim.
    expect(source).toContain("audit_initiator_kind := turn_row.initiator_kind");
    expect(source).toContain("audit_authority_epoch := session_row.authority_epoch");
    expect(source).toContain("'causalHumanSubjectId', causal_human");
    expect(source).not.toMatch(/\bDROP TABLE\b/u);
  });

  test("an authorized connection use records the frozen initiator and session authority", async () => {
    if (!available) return;
    const human = `user:audit-${crypto.randomUUID()}`;
    const fixture = await claimedTurnFixture(human);
    const [connection] = await admin<{ id: string }[]>`
      insert into connections (
        account_id, workspace_id, origin_workspace_id, provider_domain, kind,
        credential_encrypted
      ) values (
        ${fixture.accountId}, ${fixture.workspaceId}, ${fixture.workspaceId},
        'linear.app', 'oauth2', 'ciphertext-never-read-by-authority'
      ) returning id`;
    const physicalRequestId = crypto.randomUUID();
    const resolution = await resolveAcceptedConnectionUse(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      attemptId: fixture.attemptId,
      executionGeneration: fixture.executionGeneration,
      physicalRequestId,
      usePhase: "credential_resolution",
      serverId: "linear",
      connectionId: connection!.id,
      providerDomain: "linear.app",
      connectionKind: "oauth2",
      subjectScope: "workspace",
    });
    expect(resolution.status).toBe("authorized");
    const [audit] = await admin<
      Array<{
        initiator_kind: string | null;
        initiator_subject_id: string | null;
        initiating_human_subject_id: string | null;
        authority_epoch: number | null;
        authority_visibility: string | null;
      }>
    >`
      select initiator_kind, initiator_subject_id, initiating_human_subject_id,
        authority_epoch, authority_visibility
      from connection_use_audit_facts
      where physical_request_id = ${physicalRequestId}`;
    const [turn] = await admin<Array<{ initiator_kind: string; initiator_subject_id: string }>>`
      select initiator_kind, initiator_subject_id from session_turns
      where id = ${fixture.turnId}`;
    expect(audit).toEqual({
      initiator_kind: turn!.initiator_kind,
      initiator_subject_id: turn!.initiator_subject_id,
      initiating_human_subject_id:
        turn!.initiator_subject_id === "unattributed-legacy" ? null : human,
      authority_epoch: 1,
      authority_visibility: "workspace_shared",
    });
  });

  test("a fence-denied use records NULL attribution honestly", async () => {
    if (!available) return;
    const fixture = await claimedTurnFixture();
    await admin`update sessions set status = 'cancelled' where id = ${fixture.sessionId}`;
    const physicalRequestId = crypto.randomUUID();
    const resolution = await resolveAcceptedConnectionUse(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      attemptId: fixture.attemptId,
      executionGeneration: fixture.executionGeneration,
      physicalRequestId,
      usePhase: "credential_resolution",
      serverId: "linear",
      connectionId: crypto.randomUUID(),
      providerDomain: "linear.app",
      subjectScope: "workspace",
    });
    expect(resolution).toEqual({ status: "denied", reason: "session_identity_changed" });
    const [audit] = await admin<
      Array<{ outcome: string; initiator_kind: string | null; authority_epoch: number | null }>
    >`
      select outcome, initiator_kind, authority_epoch
      from connection_use_audit_facts
      where physical_request_id = ${physicalRequestId}`;
    // The session row loaded (its authority is honest evidence) but the turn
    // fence failed, so the initiator stays NULL.
    expect(audit).toMatchObject({ outcome: "denied", initiator_kind: null });
  });

  test("a variable-set materialization records the attempt authority and owner identity", async () => {
    if (!available) return;
    const human = `user:vs-audit-${crypto.randomUUID()}`;
    const fixture = await claimedTurnFixture(human);
    const [variableSet] = await admin<{ id: string }[]>`
      insert into workspace_variable_sets (account_id, workspace_id, name, origin_workspace_id)
      values (${fixture.accountId}, ${fixture.workspaceId}, 'audited set', ${fixture.workspaceId})
      returning id`;
    await admin`
      insert into workspace_variable_set_variables (
        account_id, workspace_id, variable_set_id, name, value_encrypted
      ) values (
        ${fixture.accountId}, ${fixture.workspaceId}, ${variableSet!.id}, 'TOKEN', 'ciphertext'
      )`;
    await admin`
      update sessions set variable_set_id = ${variableSet!.id} where id = ${fixture.sessionId}`;
    const result = await getVariableSetValuesForRun(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      variableSetId: variableSet!.id,
      authority: {
        kind: "agent_attempt",
        subjectId: human,
        sessionId: fixture.sessionId,
        turnId: fixture.turnId,
        attemptId: fixture.attemptId,
        executionGeneration: fixture.executionGeneration,
        initiatingHumanSubjectId: human,
      },
    });
    expect(result?.values).toEqual({ TOKEN: "ciphertext" });
    const [audit] = await admin<Array<{ metadata: Record<string, unknown> }>>`
      select metadata from audit_events
      where workspace_id = ${fixture.workspaceId}
        and action = 'variable_set.materialized'
      order by occurred_at desc limit 1`;
    expect(audit!.metadata).toMatchObject({
      variableSetId: variableSet!.id,
      causalHumanSubjectId: human,
      authorityEpoch: 1,
      authorityVisibility: "workspace_shared",
      originWorkspaceId: fixture.workspaceId,
    });
  });

  test("a denied materialization is recorded from a fresh transaction without weakening the failure", async () => {
    if (!available) return;
    const human = `user:vs-denied-${crypto.randomUUID()}`;
    const fixture = await claimedTurnFixture(human);
    const [variableSet] = await admin<{ id: string }[]>`
      insert into workspace_variable_sets (account_id, workspace_id, name, origin_workspace_id)
      values (${fixture.accountId}, ${fixture.workspaceId}, 'unselected set', ${fixture.workspaceId})
      returning id`;
    // The session never selected this set -> the seam raises 42501 and rolls
    // its transaction back; the caller records the denial separately.
    const attempt = getVariableSetValuesForRun(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      variableSetId: variableSet!.id,
      authority: {
        kind: "agent_attempt",
        subjectId: human,
        sessionId: fixture.sessionId,
        turnId: fixture.turnId,
        attemptId: fixture.attemptId,
        executionGeneration: fixture.executionGeneration,
        initiatingHumanSubjectId: human,
      },
    });
    await expect(attempt).rejects.toBeTruthy();
    const [denied] = await admin<Array<{ metadata: Record<string, unknown> }>>`
      select metadata from audit_events
      where workspace_id = ${fixture.workspaceId}
        and action = 'variable_set.materialize.denied'
      order by occurred_at desc limit 1`;
    expect(denied!.metadata).toMatchObject({
      outcome: "denied",
      variableSetId: variableSet!.id,
      sessionId: fixture.sessionId,
      attemptId: fixture.attemptId,
    });
    const [materialized] = await admin<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where workspace_id = ${fixture.workspaceId}
        and action = 'variable_set.materialized'`;
    expect(materialized!.count).toBe(0);
  });

  test("a denied secret read records its denial in the surviving outer transaction", async () => {
    if (!available) return;
    const human = `user:secret-denied-${crypto.randomUUID()}`;
    const fixture = await claimedTurnFixture(human);
    const [variableSet] = await admin<{ id: string }[]>`
      insert into workspace_variable_sets (account_id, workspace_id, name, origin_workspace_id)
      values (
        ${fixture.accountId}, ${fixture.workspaceId}, 'secret set', ${fixture.workspaceId}
      ) returning id`;
    // The session never selected this set: the seam raises inside a savepoint
    // and the typed rejection still reaches the caller while the denial audit
    // row commits with the outer transaction.
    const attempt = readVariableSetSecretAtomically(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      subjectId: human,
      variableSetId: variableSet!.id,
      name: "TOKEN",
      actor: {
        kind: "agent_attempt",
        sessionId: fixture.sessionId,
        turnId: fixture.turnId,
        attemptId: fixture.attemptId,
        executionGeneration: fixture.executionGeneration,
      },
      decrypt: () => {
        throw new Error("denied reads must never decrypt");
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(VariableSetSecretReadAuthorityError);
    const [denied] = await admin<Array<{ metadata: Record<string, unknown> }>>`
      select metadata from audit_events
      where workspace_id = ${fixture.workspaceId}
        and action = 'variable_set.secret.read.denied'
      order by occurred_at desc limit 1`;
    expect(denied!.metadata).toMatchObject({
      outcome: "denied",
      name: "TOKEN",
      attemptId: fixture.attemptId,
    });
  });

  test("a transient secret-read failure records no denial evidence", async () => {
    if (!available) return;
    const human = `user:secret-transient-${crypto.randomUUID()}`;
    const fixture = await claimedTurnFixture(human);
    // A nonexistent variable set fails with P0002 (no_data_found), not an
    // authority denial: the typed rejection is preserved but no durable
    // "denied" fact may be fabricated for a failure that was not one.
    const attempt = readVariableSetSecretAtomically(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      subjectId: human,
      variableSetId: crypto.randomUUID(),
      name: "TOKEN",
      actor: {
        kind: "agent_attempt",
        sessionId: fixture.sessionId,
        turnId: fixture.turnId,
        attemptId: fixture.attemptId,
        executionGeneration: fixture.executionGeneration,
      },
      decrypt: () => {
        throw new Error("must never decrypt");
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(VariableSetSecretReadAuthorityError);
    const [denied] = await admin<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where workspace_id = ${fixture.workspaceId}
        and action = 'variable_set.secret.read.denied'`;
    expect(denied!.count).toBe(0);
  });
});
