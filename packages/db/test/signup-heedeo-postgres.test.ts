import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  completeSelfServiceOrganizationSetupWithSignupNetwork,
  createDb,
  listSignupHeedeoVerdicts,
  nestedPostgresSqlState,
  readHeedeoSignupMode,
  readSignupNetworkVelocitySettings,
  recordSignupHeedeoEvaluation,
  resetHeedeoSignupModeCache,
  setSignupNetworkVelocitySettings,
  type DbClient,
  type SignupNetworkVelocityChanges,
} from "../src";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
} from "../src/runtime-posture";

// Migration 1566: Heedeo signup scoring's operator mode (through the 1494
// network velocity setter) and its verdict table. Synthetic ids only.
let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
let ownerClient: DbClient | null = null;
const DAY = 86_400_000;

beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase("signup-heedeo", "signup_heedeo");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl, { max: 2, searchPath: shared.schema });
  ownerClient = createDb(shared.ownerUrl, { max: 2, searchPath: shared.schema });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await ownerClient?.close();
  await shared?.release();
}, 180_000);

async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return nestedPostgresSqlState(error) ?? "unknown";
  }
}

async function configure(changes: SignupNetworkVelocityChanges) {
  const current = await readSignupNetworkVelocitySettings(ownerClient!.db);
  return await setSignupNetworkVelocitySettings(ownerClient!.db, {
    changes,
    operator: "operator:test",
    reason: "heedeo signup mode test",
    expectedRevision: current.revision,
  });
}

async function runtimeMode() {
  resetHeedeoSignupModeCache();
  return await readHeedeoSignupMode(client!.db);
}

test("the mode is off until set, changes through the network velocity setter and is readable by the runtime", async () => {
  if (!shared || !client || !ownerClient) return;
  expect((await readSignupNetworkVelocitySettings(ownerClient.db)).heedeoSignupMode).toBe("off");
  expect(await runtimeMode()).toBe("off");

  const result = await configure({ heedeoSignupMode: "shadow" });
  expect(result.current.heedeoSignupMode).toBe("shadow");
  expect(await runtimeMode()).toBe("shadow");
  // Another change keeps the mode and appends no mode revision.
  await configure({ mode: "observe" });
  await configure({ heedeoSignupMode: "shadow" });
  expect(await runtimeMode()).toBe("shadow");
  await configure({ heedeoSignupMode: "enforce" });
  expect(await runtimeMode()).toBe("enforce");
  const revisions = await shared.admin`select revision::int, mode, changed_by, database_role
    from opengeni_private.signup_heedeo_mode_revisions where data_schema = ${shared.schema}
    order by revision`;
  expect(revisions.map((row) => [row.revision, row.mode])).toEqual([
    [1, "shadow"],
    [2, "enforce"],
  ]);
  expect(revisions[1]).toMatchObject({
    changed_by: "operator:test",
    database_role: shared.ownerRole,
  });

  const current = await readSignupNetworkVelocitySettings(ownerClient.db);
  expect(
    await sqlState(() =>
      setSignupNetworkVelocitySettings(ownerClient!.db, {
        changes: { heedeoSignupMode: "sometimes" as "off" },
        operator: "operator:test",
        reason: "invalid heedeo mode",
        expectedRevision: current.revision,
      }),
    ),
  ).toBe("22023");
  // The ops workflow passes raw JSON changes.
  await ownerClient.db.execute(sql`select opengeni_private.set_signup_network_velocity(
    '{"heedeoSignupMode":"off"}'::jsonb, 'operator:json', 'ops json change', ${current.revision}::bigint)`);
  expect(await runtimeMode()).toBe("off");
  await configure({ mode: "off" });

  // The runtime reads the mode, never writes it or reads the settings.
  for (const statement of [
    sql`insert into opengeni_private.signup_heedeo_mode_revisions (data_schema, revision, mode, changed_by, reason)
      values (current_schema(), 99, 'off', 'forged', 'forged change')`,
    sql`select opengeni_private.signup_network_velocity_settings('x')`,
  ]) {
    expect(await sqlState(() => Promise.resolve(client!.db.execute(statement)))).toBe("42501");
  }
}, 180_000);

test("the runtime appends verdicts it cannot read and prunes only expired ones; operators list them with our decision", async () => {
  if (!shared || !client || !ownerClient) return;
  const userId = crypto.randomUUID();
  await shared.admin`insert into auth_users(id,name,email,email_verified)
    values (${userId},'Heedeo owner',${`${userId}@example.test`},true)`;
  const { setup } = await completeSelfServiceOrganizationSetupWithSignupNetwork(client.db, {
    authUserId: userId,
    actorSubjectId: `user:${userId}`,
    organizationName: "Heedeo organization",
    operationId: crypto.randomUUID(),
    requestFingerprint: "a".repeat(64),
    trialCreditsEnabled: true,
    trialCreditModelIds: ["model-a"],
    signupNetwork: null,
  } as Parameters<typeof completeSelfServiceOrganizationSetupWithSignupNetwork>[1]);
  const accountId = setup.organizationId;
  const [existing] = await shared.admin<{ revision: number }[]>`select revision::int as revision
    from promotion_decisions where account_id = ${accountId}`;
  const previousRevision = existing?.revision ?? 0;
  await shared.admin`select opengeni_private.set_promotion_decision(${accountId}::uuid,'held',
    'operator-v1','manual-review','{}'::jsonb,'operator:test',${previousRevision}::bigint)`;

  await shared.admin`insert into opengeni_private.signup_heedeo_evaluations
    (data_schema, created_at, user_id, signup_method, mode, outcome, token_present)
    values (${shared.schema}, clock_timestamp() - interval '200 days', 'expired', 'email', 'shadow', 'evaluated', true),
      (${shared.schema}, clock_timestamp() - interval '100 days', 'kept', 'email', 'shadow', 'evaluated', true)`;

  await recordSignupHeedeoEvaluation(client.db, {
    userId,
    signupMethod: "google",
    mode: "shadow",
    outcome: "evaluated",
    httpStatus: 200,
    latencyMs: 312,
    tokenPresent: true,
    noToken: false,
    evaluationId: "evt_123",
    score: 150,
    band: "review",
    flagged: true,
    reasonCodes: ["repeat_action", "many_identities", "not a code"],
    visitorId: "vis_456",
  });
  await recordSignupHeedeoEvaluation(client.db, {
    userId: null,
    signupMethod: "email",
    mode: "enforce",
    outcome: "refused",
    tokenPresent: false,
    flagged: true,
    errorCode: "Bad Code",
    httpStatus: 9_999,
  });

  const rows = await shared.admin`select user_id, signup_method, mode, outcome, error_code,
      http_status, latency_ms, token_present, no_token, evaluation_id, score, band, flagged,
      reason_codes, visitor_id
    from opengeni_private.signup_heedeo_evaluations where data_schema = ${shared.schema}
    order by created_at`;
  expect(rows.map((row) => row.user_id)).toEqual(["kept", userId, null]);
  expect(rows[1]).toMatchObject({
    signup_method: "google",
    mode: "shadow",
    outcome: "evaluated",
    error_code: null,
    http_status: 200,
    latency_ms: 312,
    token_present: true,
    no_token: false,
    evaluation_id: "evt_123",
    score: 150,
    band: "review",
    flagged: true,
    reason_codes: ["repeat_action", "many_identities"],
    visitor_id: "vis_456",
  });
  // Values that don't fit are dropped, never failing the write.
  expect(rows[2]).toMatchObject({ outcome: "refused", error_code: null, http_status: null });

  expect(
    await sqlState(() =>
      Promise.resolve(
        client!.db.execute(sql`select * from opengeni_private.signup_heedeo_evaluations`),
      ),
    ),
  ).toBe("42501");
  expect(
    await sqlState(() =>
      Promise.resolve(
        client!.db.execute(
          sql`update opengeni_private.signup_heedeo_evaluations set flagged = false`,
        ),
      ),
    ),
  ).toBe("42501");

  const all = await listSignupHeedeoVerdicts(ownerClient.db, { limit: 10 });
  expect(all.map((verdict) => verdict.userId)).toEqual([null, userId, "kept"]);
  const mine = await listSignupHeedeoVerdicts(ownerClient.db, { accountId });
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({
    userId,
    signupMethod: "google",
    flagged: true,
    band: "review",
    score: 150,
    reasonCodes: ["repeat_action", "many_identities"],
    organizations: [
      {
        accountId,
        decision: "held",
        decisionRevision: previousRevision + 1,
        ruleId: "manual-review",
        policyVersion: "operator-v1",
      },
    ],
  });
  expect(JSON.stringify(all)).not.toContain("@example.test");
  expect(Date.parse(mine[0]!.createdAt)).toBeGreaterThan(Date.now() - DAY);

  const options = {
    expectedRole: "opengeni_app",
    targetSchema: shared.schema,
    rlsStrategy: "force" as const,
  };
  const posture = await inspectRuntimeDatabasePosture(client.db, options);
  expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual([]);
}, 180_000);
