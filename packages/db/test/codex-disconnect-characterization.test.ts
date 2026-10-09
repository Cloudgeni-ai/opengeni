/**
 * Pre-fix characterization for graceful disconnect. These assertions deliberately
 * describe the legacy defects, NOT the desired drain contract. This deliberately
 * pre-cutover fixture complements the positive shared-core request/drain tests;
 * it must not run those historical assertions on the cut-over runtime. Fake credentials only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { acquireBlankTestDatabase, testSettings, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  createSession,
  disconnectOrganizationCodexAccount,
  encryptEnvironmentValue,
  loadCodexCredentialForRun,
  upsertOrganizationCodexSubscriptionCredential,
  withRlsContext,
  withSessionActivityRlsContext,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

let shared: SharedTestDatabase | null = null;
let client: DbClient;
const settings = testSettings({
  codexSubscriptionEnabled: true,
  environmentsEncryptionKey: Buffer.alloc(32, 19).toString("base64"),
});

async function fixture() {
  const admin = shared!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('disconnect characterization') returning id`;
  const organizationId = account!.id;
  const [personal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${organizationId}, 'owner Personal') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${organizationId}, 'shared fixture') returning id`;
  const workspaceId = workspace!.id;
  const actorSubjectId = `user:${crypto.randomUUID()}`;
  await admin`insert into organization_memberships
    (account_id, subject_id, role, status, personal_workspace_id)
    values (${organizationId}, ${actorSubjectId}, 'owner', 'active', ${personal!.id})`;
  for (const id of [personal!.id, workspaceId]) {
    await admin`insert into workspace_inference_controls (account_id, workspace_id)
      values (${organizationId}, ${id})`;
  }
  const credential = await upsertOrganizationCodexSubscriptionCredential(client.db, {
    organizationId,
    actorSubjectId,
    credentialEncrypted: encryptEnvironmentValue(
      Buffer.from(settings.environmentsEncryptionKey!, "base64"),
      JSON.stringify({
        access_token: "fake-access",
        refresh_token: "fake-refresh",
        id_token: "fake-id",
      }),
    ),
    chatgptAccountId: crypto.randomUUID(),
    scopes: null,
    planType: "pro",
    isFedramp: false,
    expiresAt: new Date(Date.now() + 3_600_000),
    lastRefreshAt: new Date(),
  });
  const session = await createSession(client.db, {
    accountId: organizationId,
    workspaceId,
    initialMessage: "synthetic disconnect test",
    resources: [],
    tools: [],
    metadata: {},
    model: "codex/gpt-5",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const triggerEventId = crypto.randomUUID();
  await withSessionActivityRlsContext(
    client.db,
    { accountId: organizationId, workspaceId },
    async (tx) => {
      await tx.execute(sql`insert into session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, sandbox_backend,
      execution_generation, active_attempt_id, metadata
    ) values (
      ${turnId}, ${organizationId}, ${workspaceId}, ${session.id}, ${triggerEventId}, 'fixture',
      'running', 1, 'fixture', 'codex/gpt-5', 'medium', 'none', 1, ${attemptId},
      jsonb_build_object('dispatchGeneration', 1, 'dispatchAttempt', jsonb_build_object(
        'id', ${`activity:${attemptId}`}::text, 'generation', 1, 'triggerEventId', ${triggerEventId}::uuid))
    )`);
      await tx.execute(
        sql`update sessions set status = 'running', active_turn_id = ${turnId} where id = ${session.id}`,
      );
      await tx.execute(sql`insert into session_turn_attempts (
      id, account_id, workspace_id, session_id, turn_id, execution_generation, state,
      temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
      verified_control_revision, mcp_approval_policies
    ) values (
      ${attemptId}, ${organizationId}, ${workspaceId}, ${session.id}, ${turnId}, 1, 'claimed',
      'fixture', ${`run:${attemptId}`}, ${`activity:${attemptId}`}, 0, '{}'::jsonb
    )`);
    },
  );
  await withRlsContext(client.db, { accountId: organizationId, workspaceId }, async (tx) => {
    await tx.execute(sql`insert into codex_credential_leases (
      account_id, workspace_id, credential_id, turn_id, holder_id, generation, leased_until
    ) values (${organizationId}, ${workspaceId}, ${credential.id}, ${turnId}, 'fixture-holder', 1,
      clock_timestamp() + interval '5 minutes')`);
  });
  return {
    organizationId,
    workspaceId,
    actorSubjectId,
    credentialId: credential.id,
    turnId,
    attemptId,
  };
}

const describeRealDatabase =
  process.env.OPENGENI_REQUIRE_REAL_DB === "1" ? describe : describe.skip;

describeRealDatabase("legacy Codex disconnect: known pre-fix behavior", () => {
  beforeAll(async () => {
    const owned = await acquireBlankTestDatabase("codex-disconnect-characterization");
    if (!owned) throw new Error("Disconnect characterization requires real PostgreSQL");
    const appUrl = new URL(owned.databaseUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = owned.appPassword;
    shared = {
      admin: postgres(owned.databaseUrl, { max: 4 }),
      adminUrl: owned.databaseUrl,
      appUrl: appUrl.toString(),
      release: async () => {
        await shared!.admin.end();
        await owned.release();
      },
    };
    const owner = postgres(owned.databaseUrl, { max: 1 });
    try {
      // This is a historical protocol fixture, not a supported rollback path.
      // Preserve the original superuser-owned migration baseline here; the
      // positive core suite separately exercises the NOBYPASSRLS owner posture.
      await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
      await owner`insert into schema_migrations(name) values ('0685_subscription_core_codex_cutover.sql')`;
      await migrate(owned.databaseUrl);
      await provisionRoles(owned.databaseUrl, { appPassword: owned.appPassword });
    } finally {
      await owner.end();
    }
    client = createDb(shared.appUrl, { max: 4 });
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    await shared?.release();
  }, 180_000);

  test("live-use rejection does not establish a new-work fence", async () => {
    const f = await fixture();
    let failure: unknown;
    try {
      await disconnectOrganizationCodexAccount(client.db, f);
    } catch (error) {
      failure = error;
    }
    const databaseError = (failure as { cause?: unknown } | undefined)?.cause ?? failure;
    expect(databaseError).toMatchObject({ code: "55006" });
    expect(String(databaseError)).toContain("active turns are using it");
    const [row] = await shared!
      .admin`select allocator_enabled from codex_subscription_credentials where id = ${f.credentialId}`;
    expect(row?.allocator_enabled).toBe(true);
    // A new, unleased operation can still resolve this bearer after failed DELETE.
    expect(
      (await loadCodexCredentialForRun(client.db, settings, f.workspaceId, f.credentialId))?.id,
    ).toBe(f.credentialId);
  });

  test("expired lease permits deletion without an exact physical quiescence receipt", async () => {
    const f = await fixture();
    await shared!
      .admin`update codex_credential_leases set leased_until = clock_timestamp() - interval '1 second'
      where credential_id = ${f.credentialId}`;
    const [before] = await shared!
      .admin`select state, quiesced_at from session_turn_attempts where id = ${f.attemptId}`;
    expect(before).toMatchObject({ state: "claimed", quiesced_at: null });
    // This is precisely why expired-row pruning is NOT graceful drain proof.
    expect(await disconnectOrganizationCodexAccount(client.db, f)).toMatchObject({ removed: true });
    const [after] = await shared!
      .admin`select state, quiesced_at from session_turn_attempts where id = ${f.attemptId}`;
    expect(after).toMatchObject({ state: "claimed", quiesced_at: null });
    expect(
      await loadCodexCredentialForRun(client.db, settings, f.workspaceId, f.credentialId),
    ).toBeNull();
  });

  test("allocator pause is not credential-use revocation", async () => {
    const f = await fixture();
    await shared!
      .admin`update codex_subscription_credentials set allocator_enabled = false where id = ${f.credentialId}`;
    expect(
      (await loadCodexCredentialForRun(client.db, settings, f.workspaceId, f.credentialId))?.id,
    ).toBe(f.credentialId);
  });

  test("non-administrator cannot turn the disconnect entry point into deletion authority", async () => {
    const f = await fixture();
    await expect(
      disconnectOrganizationCodexAccount(client.db, {
        ...f,
        actorSubjectId: `user:${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow();
    expect(
      await shared!
        .admin`select id from codex_subscription_credentials where id = ${f.credentialId}`,
    ).toHaveLength(1);
  });
});
