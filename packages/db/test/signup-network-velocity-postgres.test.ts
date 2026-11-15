import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  acceptOrganizationInvitation,
  applyCreditLedgerEntry,
  completeSelfServiceOrganizationSetupWithSignupNetwork,
  createDb,
  createOrganizationInvitation,
  evaluateSignupNetworkAccounts,
  freePlanCreditEligible,
  getBillingBalance,
  getSpendableCreditBalance,
  grantPlanCreditPeriod,
  listSignupNetworkHolds,
  nestedPostgresSqlState,
  readSignupNetworkVelocitySettings,
  releaseSignupNetworkHolds,
  setSignupNetworkVelocitySettings,
  spendableCreditMicros,
  upsertOrganizationPlan,
  type DbClient,
  type SignupNetworkSource,
  type SignupNetworkVelocityChanges,
} from "../src";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
} from "../src/runtime-posture";

// Migration 1354: signup network velocity. Synthetic accounts and
// synthetic network hashes only; the API derives real hashes with an HMAC.
let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
let ownerClient: DbClient | null = null;
const M = 1_000_000;
const HOUR = 3_600_000;

beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase("signup-network-velocity", "signup_net");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4, searchPath: shared.schema });
  ownerClient = createDb(shared.ownerUrl, { max: 2, searchPath: shared.schema });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await ownerClient?.close();
  await shared?.release();
}, 180_000);

const hex = (label: string) => new Bun.CryptoHasher("sha256").update(label).digest("hex");
/** A synthetic network: its own exact hash and, by default, its own prefix. */
function network(name: string, prefix = name): SignupNetworkSource {
  return { addressHash: hex(`address:${name}`), prefixHash: hex(`prefix:${prefix}`) };
}
let networkCounter = 0;
const fresh = (label: string) => network(`${label}-${++networkCounter}-${crypto.randomUUID()}`);

type Owner = { accountId: string; userId: string; evaluateAccountIds: string[]; command: Command };
type Command = Parameters<typeof completeSelfServiceOrganizationSetupWithSignupNetwork>[1];

/** A new self-serve owner, followed by the API's post-commit evaluation. */
async function owner(source: SignupNetworkSource | null, options: { domain?: string } = {}) {
  const userId = crypto.randomUUID();
  await shared!.admin`insert into auth_users(id,name,email,email_verified)
    values (${userId},'Network owner',${`${userId}@${options.domain ?? "example.test"}`},true)`;
  const command: Command = {
    authUserId: userId,
    actorSubjectId: `user:${userId}`,
    organizationName: "Network organization",
    operationId: crypto.randomUUID(),
    requestFingerprint: "a".repeat(64),
    trialCreditsEnabled: true,
    trialCreditModelIds: ["model-a"],
    signupNetwork: source,
  };
  const { setup, evaluateAccountIds } = await completeSelfServiceOrganizationSetupWithSignupNetwork(
    client!.db,
    command,
  );
  const failures: unknown[] = [];
  await evaluateSignupNetworkAccounts(client!.db, evaluateAccountIds, (_id, error) =>
    failures.push(error),
  );
  expect(failures).toEqual([]);
  return { accountId: setup.organizationId, userId, evaluateAccountIds, command } as Owner;
}

/** A Free plan period of 10 credits, granted before any hold. */
async function freePeriod(accountId: string) {
  const periodStart = new Date(Date.now() - 1000);
  const periodEnd = new Date(Date.now() + HOUR);
  await upsertOrganizationPlan(client!.db, {
    accountId,
    planKey: "free",
    status: "active",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
  await grantPlanCreditPeriod(client!.db, { accountId, planKey: "free", periodStart, periodEnd });
}

async function settings() {
  return await readSignupNetworkVelocitySettings(ownerClient!.db);
}
async function configure(changes: SignupNetworkVelocityChanges) {
  return await setSignupNetworkVelocitySettings(ownerClient!.db, {
    changes,
    operator: "operator:test",
    reason: "signup network velocity test",
    expectedRevision: (await settings()).revision,
  });
}
async function decision(accountId: string) {
  const [row] = await shared!.admin`select decision, revision::int as revision, actor
    from promotion_decisions where account_id = ${accountId}`;
  return row ?? null;
}
async function observation(accountId: string) {
  const [row] = await shared!
    .admin`select evidence from opengeni_private.promotion_detector_observations
    where data_schema = ${shared!.schema} and account_id = ${accountId} and policy_version = 'ip-velocity-v1'`;
  return (row?.evidence ?? null) as Record<string, unknown> | null;
}
async function sources(accountId: string) {
  return await shared!.admin`select owner_auth_user_id, address_hash, prefix_hash, set_up_at
    from opengeni_private.signup_network_sources where data_schema = ${shared!.schema} and account_id = ${accountId}`;
}
async function age(accountIds: string[], milliseconds: number) {
  await shared!.admin`update opengeni_private.signup_network_sources
    set set_up_at = set_up_at - ${`${milliseconds} milliseconds`}::interval
    where data_schema = ${shared!.schema} and account_id = any(${accountIds}::uuid[])`;
}
async function sqlState(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return nestedPostgresSqlState(error) ?? (error as { code?: string }).code ?? "error";
  }
  return null;
}
async function release(accountId: string) {
  const current = await decision(accountId);
  await shared!.admin`select opengeni_private.set_promotion_decision(${accountId}::uuid, 'eligible',
    'operator-v1', 'manual-review', '{"reason":"normal app use"}'::jsonb, 'operator:test', ${current!.revision}::bigint)`;
}
async function enforce() {
  await shared!
    .admin`select opengeni_private.set_promotion_enforcement(true,'test','network velocity test',true)`;
  await configure({ mode: "enforce" });
}

// Tests share one database and run in order: defaults first.
test("defaults are inert; every new self-serve owner is recorded with hashes only; unknown networks and replays record nothing", async () => {
  if (!shared || !client) return;
  expect(await settings()).toMatchObject({
    revision: 0,
    mode: "off",
    windowHours: 24,
    exactHoldThreshold: 3,
    prefixHoldThreshold: null,
    rateLimitEnabled: false,
    rateLimitMax: 5,
    rateLimitWindowHours: 1,
  });
  const source = fresh("defaults");
  // Off: recorded, never evaluated, never held, and no rate limit by default.
  const owners: Owner[] = [];
  for (let n = 0; n < 7; n++) owners.push(await owner(source));
  for (const created of owners) {
    expect(created.evaluateAccountIds).toEqual([]);
    const [row] = await sources(created.accountId);
    expect(row).toMatchObject({
      owner_auth_user_id: created.userId,
      address_hash: source.addressHash,
      prefix_hash: source.prefixHash,
    });
    expect(await decision(created.accountId)).toBeNull();
    expect(await observation(created.accountId)).toBeNull();
  }
  // Unknown source: nothing recorded, so unknowns never group together.
  const unknown = await owner(null);
  expect(await sources(unknown.accountId)).toHaveLength(0);
  // A replay of the committed setup inserts no receipt and records nothing new.
  const replay = await completeSelfServiceOrganizationSetupWithSignupNetwork(client.db, {
    ...owners[0]!.command,
    signupNetwork: fresh("replay"),
  });
  expect(replay.setup.organizationId).toBe(owners[0]!.accountId);
  expect(replay.evaluateAccountIds).toEqual([]);
  expect((await sources(owners[0]!.accountId))[0]!.address_hash).toBe(source.addressHash);
  // A malformed source is ignored rather than failing setup.
  const malformed = await owner({ addressHash: "not-a-hash", prefixHash: "x" });
  expect(await sources(malformed.accountId)).toHaveLength(0);
}, 180_000);

test("observe records bounded evidence without decisions", async () => {
  if (!shared || !client) return;
  await configure({ mode: "observe" });
  const source = fresh("observe");
  const first = await owner(source, { domain: "mailinator.test" });
  expect(first.evaluateAccountIds).toEqual([first.accountId]);
  expect(await observation(first.accountId)).toBeNull(); // a single signup is not a group
  const second = await owner(source);
  const third = await owner(source);
  expect(third.evaluateAccountIds).toEqual([third.accountId, second.accountId, first.accountId]);
  for (const created of [first, second, third]) {
    const evidence = await observation(created.accountId);
    expect(evidence).toMatchObject({
      ruleId: "ip-velocity-exact-v1",
      exactGroupSize: 3,
      prefixGroupSize: 3,
      exactHoldThreshold: 3,
      prefixHoldThreshold: null,
      windowHours: 24,
      addressGroup: source.addressHash.slice(0, 16),
    });
    expect(evidence!.exactGroupSetupTimes).toHaveLength(3);
    // No raw address, full hash or email in evidence.
    const text = JSON.stringify(evidence);
    expect(text).not.toContain("@");
    expect(text).not.toContain(source.addressHash);
    expect(await decision(created.accountId)).toBeNull();
  }
}, 180_000);

test("enforce: 2 are not held, the 3rd holds the whole burst; other networks and old signups are not counted", async () => {
  if (!shared || !client) return;
  await enforce();
  try {
    const burst = fresh("burst");
    const first = await owner(burst);
    await freePeriod(first.accountId);
    const second = await owner(burst);
    expect(await decision(first.accountId)).toBeNull();
    expect(await decision(second.accountId)).toBeNull();
    expect(await freePlanCreditEligible(client.db, second.accountId)).toBe(true);
    expect(
      spendableCreditMicros(await getBillingBalance(client.db, first.accountId), "model-a"),
    ).toBe(10 * M);
    const third = await owner(burst);
    for (const created of [first, second, third]) {
      expect(await decision(created.accountId)).toMatchObject({
        decision: "held",
        actor: "service:promotion-detector",
      });
    }
    const [history] = await shared.admin`select policy_version, rule_id, evidence
      from opengeni_private.promotion_decision_history where data_schema = ${shared.schema}
      and account_id = ${first.accountId} order by revision desc limit 1`;
    expect(history).toMatchObject({
      policy_version: "ip-velocity-v1",
      rule_id: "ip-velocity-exact-v1",
    });
    // The reserve account that had Free credit no longer has it spendable.
    expect(await freePlanCreditEligible(client.db, first.accountId)).toBe(false);
    const heldBalance = await getBillingBalance(client.db, first.accountId);
    expect(heldBalance.heldCreditMicros).toBe(10 * M);
    expect(spendableCreditMicros(heldBalance, "model-a")).toBe(0);
    // Re-evaluation keeps the same detector decision (no revision churn).
    const before = await decision(third.accountId);
    await freePlanCreditEligible(client.db, third.accountId);
    expect((await decision(third.accountId))!.revision).toBe(before!.revision);

    // A single signup from another network is not held.
    const single = await owner(fresh("single"));
    expect(await decision(single.accountId)).toBeNull();
    expect(await freePlanCreditEligible(client.db, single.accountId)).toBe(true);

    // Signups outside the window do not count.
    const spread = fresh("spread");
    const old = [await owner(spread), await owner(spread)];
    await age(
      old.map((created) => created.accountId),
      30 * HOUR,
    );
    const recent = await owner(spread);
    expect(await decision(recent.accountId)).toBeNull();
    expect(await observation(recent.accountId)).toBeNull();
    for (const created of old) expect(await decision(created.accountId)).toBeNull();
  } finally {
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);

test("prefix-only groups are observed, not held, unless an operator sets a prefix threshold", async () => {
  if (!shared || !client) return;
  await enforce();
  try {
    const prefix = `shared-prefix-${crypto.randomUUID()}`;
    const created: Owner[] = [];
    for (let n = 0; n < 3; n++) created.push(await owner(network(`${prefix}-${n}`, prefix)));
    for (const account of created) expect(await decision(account.accountId)).toBeNull();
    expect(await observation(created[2]!.accountId)).toMatchObject({
      ruleId: "ip-velocity-observed-v1",
      exactGroupSize: 1,
      prefixGroupSize: 3,
    });
    await configure({ prefixHoldThreshold: 3 });
    expect(await freePlanCreditEligible(client.db, created[2]!.accountId)).toBe(false);
    expect(await decision(created[2]!.accountId)).toMatchObject({ decision: "held" });
    const [history] =
      await shared.admin`select rule_id from opengeni_private.promotion_decision_history
      where data_schema = ${shared.schema} and account_id = ${created[2]!.accountId}`;
    expect(history!.rule_id).toBe("ip-velocity-prefix-v1");
  } finally {
    await configure({ prefixHoldThreshold: null });
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);

test("manual decisions win; release restores Free credit and is never re-held; deny keeps it withheld", async () => {
  if (!shared || !client) return;
  await enforce();
  try {
    const source = fresh("manual");
    const manual = await owner(source);
    // An operator already decided this account: the detector must not overwrite it.
    await shared.admin`select opengeni_private.set_promotion_decision(${manual.accountId}::uuid,
      'verification_required','operator-v1','manual-review','{}'::jsonb,'operator:test',0)`;
    const second = await owner(source);
    await freePeriod(second.accountId);
    const third = await owner(source);
    expect(await decision(manual.accountId)).toMatchObject({
      decision: "verification_required",
      actor: "operator:test",
    });
    expect(await decision(second.accountId)).toMatchObject({ decision: "held" });
    expect(await decision(third.accountId)).toMatchObject({ decision: "held" });
    expect(
      spendableCreditMicros(await getBillingBalance(client.db, second.accountId), "model-a"),
    ).toBe(0);

    // Release: Free credit is spendable again, and a later burst member does
    // not re-hold the released account.
    await release(second.accountId);
    expect(await freePlanCreditEligible(client.db, second.accountId)).toBe(true);
    const restored = await getBillingBalance(client.db, second.accountId);
    expect(restored.heldCreditMicros).toBe(0);
    expect(spendableCreditMicros(restored, "model-a")).toBe(10 * M);
    await owner(source);
    expect(await decision(second.accountId)).toMatchObject({
      decision: "eligible",
      actor: "operator:test",
    });

    // Deny: stays denied through re-evaluation.
    const held = await decision(third.accountId);
    await shared.admin`select opengeni_private.set_promotion_decision(${third.accountId}::uuid,'denied',
      'operator-v1','manual-review','{"reason":"farm group"}'::jsonb,'operator:test',${held!.revision}::bigint)`;
    expect(await freePlanCreditEligible(client.db, third.accountId)).toBe(false);
    expect(await decision(third.accountId)).toMatchObject({
      decision: "denied",
      actor: "operator:test",
    });
    // A stale revision cannot overwrite a newer decision.
    expect(
      await sqlState(
        () => shared!
          .admin`select opengeni_private.set_promotion_decision(${third.accountId}::uuid,'eligible',
        'operator-v1','manual-review','{}'::jsonb,'operator:test',${held!.revision}::bigint)`,
      ),
    ).toBe("40001");
  } finally {
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);

test("holds leave purchased credit and paid-plan allowances usable", async () => {
  if (!shared || !client) return;
  await enforce();
  try {
    const source = fresh("paid");
    const topUp = await owner(source);
    await freePeriod(topUp.accountId);
    await applyCreditLedgerEntry(client.db, {
      accountId: topUp.accountId,
      type: "credit_topup",
      amountMicros: 3 * M,
      sourceType: "test",
      sourceId: null,
      idempotencyKey: crypto.randomUUID(),
    });
    const pro = await owner(source);
    const periodStart = new Date(Date.now() - 1000);
    const periodEnd = new Date(Date.now() + HOUR);
    const proInput = {
      accountId: pro.accountId,
      planKey: "pro",
      periodStart,
      periodEnd,
      stripeSubscriptionId: `sub_${crypto.randomUUID()}`,
    };
    await upsertOrganizationPlan(client.db, {
      ...proInput,
      status: "active",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    });
    await grantPlanCreditPeriod(client.db, proInput);
    await owner(source);
    expect(await decision(topUp.accountId)).toMatchObject({ decision: "held" });
    expect(await decision(pro.accountId)).toMatchObject({ decision: "held" });
    const topUpBalance = await getBillingBalance(client.db, topUp.accountId);
    expect(topUpBalance.heldCreditMicros).toBe(10 * M);
    expect(
      (await getSpendableCreditBalance(client.db, topUp.accountId, "model-a")).balanceMicros,
    ).toBe(3 * M);
    const proBalance = await getBillingBalance(client.db, pro.accountId);
    expect(proBalance.plan?.creditRemainingMicros).toBeGreaterThan(0);
    expect(spendableCreditMicros(proBalance, "model-a")).toBe(
      proBalance.plan!.creditRemainingMicros,
    );
  } finally {
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);

test("invited members are never recorded, counted or held", async () => {
  if (!shared || !client) return;
  await enforce();
  try {
    const source = fresh("company");
    const founder = await owner(source);
    for (let n = 0; n < 3; n++) {
      const colleague = crypto.randomUUID();
      await shared.admin`insert into auth_users(id,name,email,email_verified)
        values (${colleague},'Colleague',${`${colleague}@company.test`},true)`;
      const invitation = await createOrganizationInvitation(client.db, {
        organizationId: founder.accountId,
        actorSubjectId: `user:${founder.userId}`,
        operationId: crypto.randomUUID(),
        targetSubjectId: `user:${colleague}`,
        targetEmail: `${colleague}@company.test`,
        role: "member",
        expiresAt: new Date(Date.now() + HOUR).toISOString(),
      });
      await acceptOrganizationInvitation(client.db, {
        organizationId: founder.accountId,
        actorSubjectId: `user:${colleague}`,
        operationId: crypto.randomUUID(),
        invitationId: invitation.id,
        expectedRevision: invitation.revision,
      });
    }
    const [count] =
      await shared.admin`select count(*)::int as count from opengeni_private.signup_network_sources
      where data_schema = ${shared.schema} and address_hash = ${source.addressHash}`;
    expect(count!.count).toBe(1);
    expect(await freePlanCreditEligible(client.db, founder.accountId)).toBe(true);
    expect(await decision(founder.accountId)).toBeNull();
  } finally {
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);

test("rate limit: 5 per network per hour allowed, the 6th refused, replays allowed, old signups expire, fails open", async () => {
  if (!shared || !client) return;
  await configure({ mode: "off", rateLimitEnabled: true });
  const source = fresh("rate");
  const allowed: Owner[] = [];
  for (let n = 0; n < 5; n++) allowed.push(await owner(source));
  const userId = crypto.randomUUID();
  await shared.admin`insert into auth_users(id,name,email,email_verified)
    values (${userId},'Sixth owner',${`${userId}@example.test`},true)`;
  const sixth: Command = {
    ...allowed[0]!.command,
    authUserId: userId,
    actorSubjectId: `user:${userId}`,
    operationId: crypto.randomUUID(),
  };
  expect(
    await sqlState(() => completeSelfServiceOrganizationSetupWithSignupNetwork(client!.db, sixth)),
  ).toBe("OG429");
  // Nothing was created for the refused owner; they can still be invited later.
  expect(
    await shared.admin`select 1 from self_service_organization_setup_receipts where auth_user_id = ${userId}`,
  ).toHaveLength(0);
  expect(
    await shared.admin`select 1 from organization_memberships where subject_id = ${`user:${userId}`}`,
  ).toHaveLength(0);
  // An idempotent replay of an already committed setup is not refused.
  const replay = await completeSelfServiceOrganizationSetupWithSignupNetwork(
    client.db,
    allowed[4]!.command,
  );
  expect(replay.setup.organizationId).toBe(allowed[4]!.accountId);
  // Another network and an unknown source are unaffected.
  await owner(fresh("rate-other"));
  await owner(null);
  // A higher maximum allows more.
  await configure({ rateLimitMax: 6 });
  const raised = await completeSelfServiceOrganizationSetupWithSignupNetwork(client.db, sixth);
  expect(raised.setup.organizationId).toBeTruthy();
  await configure({ rateLimitMax: 5 });
  // Signups older than an hour no longer count.
  await age(
    [...allowed.map((created) => created.accountId), raised.setup.organizationId],
    61 * 60_000,
  );
  await owner(source);
  // Fails open when the settings cannot be read.
  const [definition] = await shared.admin`select pg_get_functiondef(
    'opengeni_private.signup_network_velocity_settings(text)'::regprocedure) as body`;
  for (let n = 0; n < 5; n++) await owner(source).catch(() => null);
  await shared.admin
    .unsafe(`CREATE OR REPLACE FUNCTION opengeni_private.signup_network_velocity_settings(p_data_schema text)
    RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
    BEGIN RAISE EXCEPTION 'settings unavailable' USING ERRCODE = 'XX000'; END $$`);
  try {
    const failOpen = await owner(source);
    expect(await sources(failOpen.accountId)).toHaveLength(1);
  } finally {
    await shared.admin.unsafe(definition!.body as string);
  }
  await configure({ rateLimitEnabled: false });
}, 180_000);

test("concurrent setups at the rate-limit boundary admit exactly the maximum", async () => {
  if (!shared || !client) return;
  await configure({ mode: "off", rateLimitEnabled: true, rateLimitMax: 2 });
  try {
    const source = fresh("concurrent-rate");
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, async () => await owner(source)),
    );
    const admitted = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter(
      (result) => result.status === "rejected" && nestedPostgresSqlState(result.reason) === "OG429",
    );
    expect(admitted).toHaveLength(2);
    expect(refused).toHaveLength(2);
  } finally {
    await configure({ rateLimitEnabled: false, rateLimitMax: 5 });
  }
}, 180_000);

test("an unexpected detector failure never blocks Free eligibility or admission", async () => {
  if (!shared || !client) return;
  await configure({ mode: "enforce" });
  const [definition] = await shared.admin`select pg_get_functiondef(
    'opengeni_private.evaluate_signup_network_velocity(uuid)'::regprocedure) as body`;
  const created = await owner(fresh("detector-failure"));
  await shared.admin
    .unsafe(`CREATE OR REPLACE FUNCTION opengeni_private.evaluate_signup_network_velocity(p_account_id uuid)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
    BEGIN RAISE EXCEPTION 'detector broken' USING ERRCODE = 'XX000'; END $$`);
  try {
    expect(await freePlanCreditEligible(client.db, created.accountId)).toBe(true);
    await getSpendableCreditBalance(client.db, created.accountId);
  } finally {
    await shared.admin.unsafe(definition!.body as string);
    await configure({ mode: "off" });
  }
}, 180_000);

test("network records older than 90 days are removed as new ones arrive, except held accounts", async () => {
  if (!shared || !client) return;
  const old = await owner(fresh("retention-old"));
  const heldOld = await owner(fresh("retention-held"));
  await shared.admin`select opengeni_private.set_promotion_decision(${heldOld.accountId}::uuid,'held',
    'operator-v1','manual-review','{}'::jsonb,'operator:test',0)`;
  await age([old.accountId, heldOld.accountId], 91 * 24 * HOUR);
  await owner(fresh("retention-new"));
  expect(await sources(old.accountId)).toHaveLength(0);
  expect(await sources(heldOld.accountId)).toHaveLength(1);
}, 180_000);

test("settings are owner-only and revision-fenced; runtime roles cannot read evidence or write settings", async () => {
  if (!shared || !client || !ownerClient) return;
  const current = await settings();
  expect(
    await sqlState(() =>
      setSignupNetworkVelocitySettings(ownerClient!.db, {
        changes: { mode: "observe" },
        operator: "operator:test",
        reason: "stale revision test",
        expectedRevision: current.revision + 1,
      }),
    ),
  ).toBe("40001");
  expect(
    await sqlState(() =>
      setSignupNetworkVelocitySettings(ownerClient!.db, {
        changes: { mode: "sometimes" as "off" },
        operator: "operator:test",
        reason: "invalid mode test",
        expectedRevision: current.revision,
      }),
    ),
  ).toBe("23514");
  expect(
    await sqlState(() =>
      setSignupNetworkVelocitySettings(ownerClient!.db, {
        changes: { unexpected: 1 } as SignupNetworkVelocityChanges,
        operator: "operator:test",
        reason: "unknown key test",
        expectedRevision: current.revision,
      }),
    ),
  ).toBe("22023");
  expect((await settings()).revision).toBe(current.revision);
  const history = await shared.admin`select revision::int, operator, reason, database_role
    from opengeni_private.signup_network_velocity_revisions where data_schema = ${shared.schema} order by revision`;
  expect(history.map((row) => row.revision)).toEqual(
    Array.from({ length: current.revision }, (_, index) => index + 1),
  );
  expect(history.at(-1)).toMatchObject({
    operator: "operator:test",
    database_role: shared.ownerRole,
  });

  for (const statement of [
    sql`select * from opengeni_private.signup_network_sources`,
    sql`select * from opengeni_private.signup_network_velocity_revisions`,
    sql`select * from opengeni_private.promotion_detector_observations`,
    sql`select opengeni_private.signup_network_velocity_settings('x')`,
    sql`select opengeni_private.set_signup_network_velocity('{"mode":"off"}'::jsonb,'operator:forged','Runtime role attempt',0)`,
    sql`select opengeni_private.evaluate_signup_network_velocity(gen_random_uuid())`,
  ]) {
    expect(await sqlState(() => Promise.resolve(client!.db.execute(statement)))).toBe("42501");
  }
  const options = {
    expectedRole: "opengeni_app",
    targetSchema: shared.schema,
    rlsStrategy: "force" as const,
  };
  const posture = await inspectRuntimeDatabasePosture(client.db, options);
  expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual([]);
}, 180_000);

test("review lists pending detector holds with domain-only evidence; bulk release restores them as operator decisions", async () => {
  if (!shared || !client || !ownerClient) return;
  await enforce();
  try {
    // Release earlier holds so this listing covers only this burst.
    await releaseSignupNetworkHolds(ownerClient.db, {
      operator: "operator:test",
      reason: "reset before review test",
    });
    const source = fresh("review");
    const burst = [
      await owner(source, { domain: "throwaway.test" }),
      await owner(source, { domain: "throwaway.test" }),
    ];
    // The first account receives Free credit while its group is still below the threshold.
    await freePeriod(burst[0]!.accountId);
    burst.push(await owner(source, { domain: "throwaway.test" }));
    const listed = await listSignupNetworkHolds(ownerClient.db);
    expect(listed.settings.mode).toBe("enforce");
    expect(listed.holdCount).toBe(3);
    expect(new Set(listed.accounts.map((account) => account.accountId))).toEqual(
      new Set(burst.map((created) => created.accountId)),
    );
    for (const account of listed.accounts) {
      expect(account).toMatchObject({
        decision: "held",
        actor: "service:promotion-detector",
        emailDomain: "throwaway.test",
        addressGroup: source.addressHash.slice(0, 16),
        exactGroupSize: 3,
        chats: 0,
        sessions: 0,
        directApiSpendMicros: 0,
        inAppSpendMicros: 0,
        unreadable: [],
      });
    }
    const reserve = listed.accounts.find((account) => account.accountId === burst[0]!.accountId)!;
    expect(reserve).toMatchObject({ freeGrantedMicros: 10 * M, freeUsedMicros: 0 });
    expect(reserve.balance).toMatchObject({ heldCreditMicros: 10 * M });
    expect(listed.groups).toHaveLength(1);
    expect(listed.groups[0]).toMatchObject({ recentOrganizations: 3, heldAccounts: 3 });
    const text = JSON.stringify(listed);
    expect(text).not.toContain(source.addressHash);
    for (const created of burst) expect(text).not.toContain(created.userId);

    // A manual hold is not released in bulk.
    const manual = await owner(fresh("manual-hold"));
    await shared.admin`select opengeni_private.set_promotion_decision(${manual.accountId}::uuid,'held',
      'operator-v1','manual-review','{}'::jsonb,'operator:test',0)`;
    const dryRun = await releaseSignupNetworkHolds(ownerClient.db, {
      operator: "operator:test",
      reason: "rollback dry run",
      dryRun: true,
    });
    expect(dryRun).toMatchObject({ candidates: 3, released: [], dryRun: true });
    expect(new Set(dryRun.wouldRelease!.map((entry) => entry.accountId))).toEqual(
      new Set(burst.map((created) => created.accountId)),
    );
    const released = await releaseSignupNetworkHolds(ownerClient.db, {
      operator: "operator:test",
      reason: "rollback of network velocity holds",
    });
    expect(released.released).toHaveLength(3);
    expect(released.skipped).toEqual([]);
    for (const created of burst)
      expect(await decision(created.accountId)).toMatchObject({
        decision: "eligible",
        actor: "operator:test",
      });
    expect(await decision(manual.accountId)).toMatchObject({
      decision: "held",
      actor: "operator:test",
    });
    expect(
      spendableCreditMicros(await getBillingBalance(client.db, burst[0]!.accountId), "model-a"),
    ).toBe(10 * M);
    expect((await listSignupNetworkHolds(ownerClient.db)).holdCount).toBe(0);
  } finally {
    await configure({ mode: "off" });
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);
