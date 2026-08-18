// Migration 0282: the session-attach variable-set materialization records the
// accepted subject and a `variable_set.materialized` audit fact with the live
// session authority tuple, closing the API-direct lane that previously
// materialized values with no subject and no audit event.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  createDb,
  createSession,
  getVariableSetValuesForRun,
  initializeSessionStartAtomically,
  type Database,
  type DbClient,
} from "../src";

const migrationUrl = new URL(
  "../drizzle/0282_variable_set_session_attach_attribution.sql",
  import.meta.url,
);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0282-session-attach-attribution");
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

async function sessionFixture(): Promise<{
  accountId: string;
  workspaceId: string;
  sessionId: string;
  variableSetId: string;
}> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('session-attach-attribution') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'session-attach-workspace') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const session = await createSession(db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    initialMessage: "attach me",
    resources: [],
    metadata: {},
    model: "test-model",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const [variableSet] = await admin<{ id: string }[]>`
    insert into workspace_variable_sets (account_id, workspace_id, name, origin_workspace_id)
    values (${account!.id}, ${workspace!.id}, 'attach set', ${workspace!.id})
    returning id`;
  await admin`
    insert into workspace_variable_set_variables (
      account_id, workspace_id, variable_set_id, name, value_encrypted
    ) values (
      ${account!.id}, ${workspace!.id}, ${variableSet!.id}, 'TOKEN', 'ciphertext'
    )`;
  await admin`
    update sessions set variable_set_id = ${variableSet!.id} where id = ${session.id}`;
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    sessionId: session.id,
    variableSetId: variableSet!.id,
  };
}

describe("migration 0282 session-attach materialization attribution", () => {
  test("declares one rolling GUC-attributed protocol with an unchanged signature", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain(
      "CREATE OR REPLACE FUNCTION materialize_scoped_variable_set_for_session(",
    );
    // The signature and grants are unchanged (rolling: old images keep calling).
    expect(source).not.toContain("p_subject_id");
    expect(source).toContain("current_setting('opengeni.subject_id', true)");
    expect(source).toContain("current_setting('opengeni.initiating_human_subject_id', true)");
    expect(source).toContain("'service:session'");
    expect(source).toContain("'variable_set.materialized'");
    expect(source).toContain("'actorKind', 'session_attach'");
    // Live session authority tuple from the exact locked session row.
    expect(source).toContain("session_value.authority_epoch");
    expect(source).toContain("session_value.owner_organization_membership_id");
    expect(source).toContain("FOR SHARE OF session_value, variable_set");
    expect(source).not.toMatch(/\bDROP\b/u);
    expect(source).not.toContain("value_encrypted'"); // metadata never carries a value key
  });

  test("a subject-attributed session attach materializes and records the audit fact", async () => {
    if (!available) return;
    const fixture = await sessionFixture();
    const human = `user:attach-${crypto.randomUUID()}`;
    const result = await getVariableSetValuesForRun(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      variableSetId: fixture.variableSetId,
      authority: { kind: "session_attach", sessionId: fixture.sessionId, subjectId: human },
    });
    expect(result?.values).toEqual({ TOKEN: "ciphertext" });
    const [audit] = await admin<Array<{ subject_id: string; metadata: Record<string, unknown> }>>`
      select subject_id, metadata from audit_events
      where workspace_id = ${fixture.workspaceId}
        and action = 'variable_set.materialized'
      order by occurred_at desc limit 1`;
    expect(audit!.subject_id).toBe(human);
    expect(audit!.metadata).toMatchObject({
      variableSetId: fixture.variableSetId,
      actorKind: "session_attach",
      sessionId: fixture.sessionId,
      causalHumanSubjectId: human,
      authorityEpoch: 1,
      authorityVisibility: "workspace_shared",
      originWorkspaceId: fixture.workspaceId,
    });
    // Metadata is attribution only - never the variable value.
    expect(JSON.stringify(audit!.metadata)).not.toContain("ciphertext");
  });

  test("a claimless (legacy/rolling) attach records the explicit service sentinel", async () => {
    if (!available) return;
    const fixture = await sessionFixture();
    const result = await getVariableSetValuesForRun(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      variableSetId: fixture.variableSetId,
      authority: { kind: "session_attach", sessionId: fixture.sessionId, subjectId: null },
    });
    expect(result?.values).toEqual({ TOKEN: "ciphertext" });
    const [audit] = await admin<Array<{ subject_id: string; metadata: Record<string, unknown> }>>`
      select subject_id, metadata from audit_events
      where workspace_id = ${fixture.workspaceId}
        and action = 'variable_set.materialized'
      order by occurred_at desc limit 1`;
    expect(audit!.subject_id).toBe("service:session");
    expect(audit!.metadata.causalHumanSubjectId).toBeNull();
  });

  test("an unselected set still fails without manufacturing audit facts", async () => {
    if (!available) return;
    const fixture = await sessionFixture();
    const [otherSet] = await admin<{ id: string }[]>`
      insert into workspace_variable_sets (account_id, workspace_id, name, origin_workspace_id)
      values (${fixture.accountId}, ${fixture.workspaceId}, 'unselected', ${fixture.workspaceId})
      returning id`;
    const attempt = getVariableSetValuesForRun(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      variableSetId: otherSet!.id,
      authority: {
        kind: "session_attach",
        sessionId: fixture.sessionId,
        subjectId: `user:deny-${crypto.randomUUID()}`,
      },
    });
    // The STRICT session-selection join raises P0002 (not 42501): the
    // transaction rolls back, no materialized fact survives, and the 42501-only
    // denial filter records no false denial evidence for a linkage miss.
    await expect(attempt).rejects.toBeTruthy();
    const [counts] = await admin<Array<{ materialized: number; denied: number }>>`
      select
        count(*) filter (where action = 'variable_set.materialized')::int as materialized,
        count(*) filter (where action = 'variable_set.materialize.denied')::int as denied
      from audit_events
      where workspace_id = ${fixture.workspaceId}`;
    expect(counts!).toMatchObject({ materialized: 0, denied: 0 });
  });
});
