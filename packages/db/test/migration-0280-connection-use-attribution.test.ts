// Migration 0280: connection-use audit facts carry the accepted authority
// attribution. (The Variable Set halves of 0280 were retired with Variable
// Sets in 0739; these connection-use cases are kept from the original suite.)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
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
  shared = await acquireSharedTestDatabase("migration-0280-connection-use-attribution");
  if (!shared) {
    available = false;
    if (requireRealDatabase) throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no database");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

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

describe("migration 0280 connection-use attribution", () => {
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
});
