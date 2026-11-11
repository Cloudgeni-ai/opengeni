import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  acceptOrganizationInvitation,
  captureFlaggedSignupNetworkOwners,
  completeSelfServiceOrganizationSetupWithSignupNetwork,
  createDb,
  createOrganizationInvitation,
  evaluateSignupNetworkAccounts,
  freePlanCreditEligible,
  getSpendableCreditBalance,
  listSignupNetworkHolds,
  nestedPostgresSqlState,
  readSignupNetworkVelocitySettings,
  releaseSignupNetworkHolds,
  setSignupNetworkVelocitySettings,
  type DbClient,
  type SignupNetworkSource,
  type SignupNetworkVelocityChanges,
} from "../src";
import {
  ensureCanonicalHumanIdentityForAuthUser,
  getCanonicalHumanExactLoginBindingForAuthUser,
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "../src/canonical-human-identities";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
} from "../src/runtime-posture";

// Migration 1368: the denied network rule. Synthetic accounts, documentation
// addresses (RFC 5737 / RFC 3849) and synthetic signup hashes only.
let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
let ownerClient: DbClient | null = null;
const DAY = 86_400_000;

beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase("signup-denied-network", "denied_net");
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
function signupNetwork(name: string, prefix = name): SignupNetworkSource {
  return { addressHash: hex(`address:${name}`), prefixHash: hex(`prefix:${prefix}`) };
}
let counter = 0;
/** A unique documentation IPv4 address (TEST-NET-2 and TEST-NET-3). */
function address() {
  counter += 1;
  return `${counter < 250 ? "198.51.100" : "203.0.113"}.${counter % 250}`;
}

type Owner = { accountId: string; userId: string; evaluateAccountIds: string[] };

/** A verified user with sessions from the given addresses (newest last). */
async function user(addresses: string[], options: { ageDays?: number } = {}) {
  const userId = crypto.randomUUID();
  await shared!.admin`insert into auth_users(id,name,email,email_verified)
    values (${userId},'Network owner',${`${userId}@example.test`},true)`;
  await shared!
    .admin`insert into auth_identities (id, user_id, account_id, provider_id, created_at, updated_at)
    values (${crypto.randomUUID()}, ${userId}, ${userId}, 'credential', now(), now())`;
  await ensureCanonicalHumanIdentityForAuthUser(client!.db, userId);
  await synchronizeCanonicalHumanLoginBindings(client!.db, userId);
  const projection = await getCanonicalHumanIdentityProjection(client!.db, userId);
  const binding = await getCanonicalHumanExactLoginBindingForAuthUser(client!.db, {
    authUserId: userId,
    providerId: "credential",
  });
  for (const ip of addresses) await session(userId, ip, projection, binding, options.ageDays ?? 0);
  return { userId, projection, binding };
}
type User = Awaited<ReturnType<typeof user>>;
async function session(
  userId: string,
  ip: string,
  projection: User["projection"],
  binding: User["binding"],
  ageDays = 0,
) {
  await shared!.admin`insert into auth_sessions (
      id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at,
      identity_id, identity_revision, auth_revision, login_binding_id, login_binding_revision
    ) values (
      ${crypto.randomUUID()}, ${userId}, ${crypto.randomUUID()}, now() + interval '7 days', ${ip},
      'Test browser', now() - ${`${ageDays} days`}::interval, now() - ${`${ageDays} days`}::interval,
      ${projection!.activeIdentity!.id}, ${projection!.activeIdentity!.identityRevision},
      ${projection!.activeIdentity!.authRevision}, ${binding!.id}, ${binding!.revision}
    )`;
}

/** A new self-serve owner signed in from `addresses`, then the API's post-commit evaluation. */
async function owner(
  addresses: string[],
  options: { source?: SignupNetworkSource | null; ageDays?: number } = {},
): Promise<Owner> {
  const { userId } = await user(addresses, options);
  const { setup, evaluateAccountIds } = await completeSelfServiceOrganizationSetupWithSignupNetwork(
    client!.db,
    {
      authUserId: userId,
      actorSubjectId: `user:${userId}`,
      organizationName: "Network organization",
      operationId: crypto.randomUUID(),
      requestFingerprint: "a".repeat(64),
      trialCreditsEnabled: true,
      trialCreditModelIds: ["model-a"],
      signupNetwork: options.source ?? null,
    },
  );
  const failures: unknown[] = [];
  await evaluateSignupNetworkAccounts(client!.db, evaluateAccountIds, (_id, error) =>
    failures.push(error),
  );
  expect(failures).toEqual([]);
  return { accountId: setup.organizationId, userId, evaluateAccountIds };
}

async function settings() {
  return await readSignupNetworkVelocitySettings(ownerClient!.db);
}
async function configure(changes: SignupNetworkVelocityChanges) {
  return await setSignupNetworkVelocitySettings(ownerClient!.db, {
    changes,
    operator: "operator:test",
    reason: "denied network test",
    expectedRevision: (await settings()).revision,
  });
}
async function decision(accountId: string) {
  const [row] = await shared!.admin`select decision, revision::int as revision, actor
    from promotion_decisions where account_id = ${accountId}`;
  return row ?? null;
}
async function decide(accountId: string, value: "denied" | "held" | "eligible") {
  const current = await decision(accountId);
  await shared!.admin`select opengeni_private.set_promotion_decision(${accountId}::uuid, ${value},
    'operator-v1', 'manual-review', '{"reason":"test review"}'::jsonb, 'operator:test',
    ${current?.revision ?? 0}::bigint)`;
}
async function observation(accountId: string) {
  const [row] = await shared!
    .admin`select evidence from opengeni_private.promotion_detector_observations
    where data_schema = ${shared!.schema} and account_id = ${accountId} and policy_version = 'denied-network-v1'`;
  return (row?.evidence ?? null) as Record<string, unknown> | null;
}
async function lastHistory(accountId: string) {
  const [row] = await shared!.admin`select policy_version, rule_id, evidence
    from opengeni_private.promotion_decision_history where data_schema = ${shared!.schema}
    and account_id = ${accountId} order by revision desc limit 1`;
  return row ?? null;
}
async function evaluate(accountId: string) {
  await evaluateSignupNetworkAccounts(client!.db, [accountId], (_id, error) => {
    throw error;
  });
}
async function sqlState(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return nestedPostgresSqlState(error) ?? (error as { code?: string }).code ?? "error";
  }
  return null;
}
async function enforce() {
  await shared!
    .admin`select opengeni_private.set_promotion_enforcement(true,'test','denied network test',true)`;
  await configure({ deniedNetworkMode: "enforce" });
}
const HELD = { decision: "held", actor: "service:promotion-detector" };

// Tests share one database and run in order: defaults first.
test("defaults are off; exact networks only; owners' session networks are stored as keyed hashes", async () => {
  if (!shared || !client) return;
  expect(await settings()).toMatchObject({
    revision: 0,
    mode: "off",
    deniedNetworkMode: "off",
    deniedNetworkLookbackDays: 90,
  });
  const units = await shared.admin`select
    opengeni_private.signup_network_exact_unit('198.51.100.7') as v4,
    opengeni_private.signup_network_exact_unit('::ffff:198.51.100.7') as mapped,
    opengeni_private.signup_network_exact_unit(' 198.51.100.7, 10.0.0.1') as forwarded,
    opengeni_private.signup_network_exact_unit('2001:db8:1:2:aaaa::1') as v6,
    opengeni_private.signup_network_exact_unit('2001:db8:1:2:bbbb::2') as same64,
    opengeni_private.signup_network_exact_unit('2001:db8:1:3::1') as other64,
    opengeni_private.signup_network_exact_unit('not an address') as garbage,
    opengeni_private.signup_network_exact_unit('') as empty`;
  expect(units[0]).toMatchObject({
    v4: "198.51.100.7",
    mapped: "198.51.100.7",
    forwarded: "198.51.100.7",
    v6: "2001:db8:1:2::/64",
    same64: "2001:db8:1:2::/64",
    other64: "2001:db8:1:3::/64",
    garbage: null,
    empty: null,
  });
  const ip = address();
  const created = await owner([ip]);
  // Off: recorded but never evaluated, observed or held.
  expect(created.evaluateAccountIds).toEqual([]);
  const rows =
    await shared.admin`select address_hash from opengeni_private.signup_network_owner_addresses
    where data_schema = ${shared.schema} and account_id = ${created.accountId}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.address_hash).toMatch(/^[0-9a-f]{64}$/);
  // Keyed: not a plain hash of the address or of the hashed label.
  expect(rows[0]!.address_hash).not.toBe(hex(ip));
  expect(rows[0]!.address_hash).not.toBe(hex(`address:${ip}`));
  const [dump] = await shared.admin`select string_agg(t::text, ' ') as text
    from opengeni_private.signup_network_owner_addresses t where data_schema = ${shared.schema}`;
  expect(String(dump!.text)).not.toContain(ip);
  expect(await decision(created.accountId)).toBeNull();
  expect(await observation(created.accountId)).toBeNull();
}, 180_000);

test("observe records what it would hold, without a decision, even with velocity off", async () => {
  if (!shared || !client) return;
  await configure({ deniedNetworkMode: "observe" });
  const ip = address();
  const farm = await owner([ip]);
  await decide(farm.accountId, "denied");
  const next = await owner([ip]);
  expect(next.evaluateAccountIds).toEqual([next.accountId]);
  const evidence = await observation(next.accountId);
  expect(evidence).toMatchObject({
    ruleId: "denied-network-exact-v1",
    deniedAccounts: 1,
    heldAccounts: 0,
    matchedVia: ["sign-in"],
    matchedAccountIds: [farm.accountId],
    lookbackDays: 90,
    mode: "observe",
  });
  const text = JSON.stringify(evidence);
  expect(text).not.toContain(ip);
  expect(text).not.toContain("@");
  expect(await decision(next.accountId)).toBeNull();
  expect(await freePlanCreditEligible(client.db, next.accountId)).toBe(true);
}, 180_000);

test("enforce holds the first signup from a denied account's network; unrelated networks and prefix-only matches are not held", async () => {
  if (!shared || !client) return;
  await enforce();
  try {
    expect((await settings()).mode).toBe("off"); // velocity off: no burst needed
    // Sign-in network of a denied account with no signup network record, like
    // the accounts denied before migration 1354.
    const ip = "198.51.100.240";
    const old = await owner([ip], { source: null });
    await decide(old.accountId, "denied");
    const first = await owner([ip]);
    expect(await decision(first.accountId)).toMatchObject(HELD);
    expect(await lastHistory(first.accountId)).toMatchObject({
      policy_version: "denied-network-v1",
      rule_id: "denied-network-exact-v1",
    });
    expect(await freePlanCreditEligible(client.db, first.accountId)).toBe(false);

    // An unrelated network is not held.
    const unrelated = await owner([address()]);
    expect(await decision(unrelated.accountId)).toBeNull();
    expect(await observation(unrelated.accountId)).toBeNull();
    expect(await freePlanCreditEligible(client.db, unrelated.accountId)).toBe(true);

    // Same /24 (IPv4) or same /48 but another /64 (IPv6): never held.
    const v4Neighbour = await owner(["198.51.100.241"]);
    expect(await decision(v4Neighbour.accountId)).toBeNull();
    const v6Farm = await owner(["2001:db8:aa:1::10"]);
    await decide(v6Farm.accountId, "denied");
    const v6Neighbour = await owner(["2001:db8:aa:2::10"]);
    expect(await decision(v6Neighbour.accountId)).toBeNull();
    // The same /64 is the same network.
    const v6Same = await owner(["2001:db8:aa:1:ffff::99"]);
    expect(await decision(v6Same.accountId)).toMatchObject(HELD);

    // Signup networks (the API's 1354 address hash): same exact network held,
    // same prefix only not held.
    const signupFarm = await owner([], { source: signupNetwork("farm-exact", "farm-prefix") });
    await decide(signupFarm.accountId, "denied");
    const viaSignup = await owner([], { source: signupNetwork("farm-exact", "farm-prefix") });
    expect(await decision(viaSignup.accountId)).toMatchObject(HELD);
    expect(await observation(viaSignup.accountId)).toMatchObject({
      matchedVia: ["signup"],
      deniedAccounts: 1,
    });
    const prefixOnly = await owner([], { source: signupNetwork("farm-other", "farm-prefix") });
    expect(await decision(prefixOnly.accountId)).toBeNull();
  } finally {
    await configure({ deniedNetworkMode: "off" });
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);

test("currently held accounts count, released and eligible accounts do not, and old use does not", async () => {
  if (!shared || !client) return;
  await enforce();
  try {
    const heldIp = address();
    const held = await owner([heldIp]);
    await decide(held.accountId, "held");
    const afterHeld = await owner([heldIp]);
    expect(await decision(afterHeld.accountId)).toMatchObject(HELD);
    expect(await observation(afterHeld.accountId)).toMatchObject({ heldAccounts: 1 });

    // Once released, the network no longer counts.
    const releasedIp = address();
    const released = await owner([releasedIp]);
    await decide(released.accountId, "held");
    await decide(released.accountId, "eligible");
    const afterRelease = await owner([releasedIp]);
    expect(await decision(afterRelease.accountId)).toBeNull();

    // Use more than 90 days before the signup does not count.
    const staleIp = address();
    const stale = await owner([staleIp]);
    await decide(stale.accountId, "denied");
    await shared.admin`update auth_sessions
      set created_at = now() - interval '120 days', updated_at = now() - interval '100 days'
      where user_id = ${stale.userId}`;
    await shared.admin`update opengeni_private.signup_network_owner_addresses
      set first_seen_at = now() - interval '120 days', last_seen_at = now() - interval '100 days'
      where data_schema = ${shared.schema} and account_id = ${stale.accountId}`;
    const afterStale = await owner([staleIp]);
    expect(await decision(afterStale.accountId)).toBeNull();
  } finally {
    await configure({ deniedNetworkMode: "off" });
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);

test("decisions capture networks that outlive the sessions; the operator capture adds later sign-ins and old denials", async () => {
  if (!shared || !client) return;
  await enforce();
  try {
    const ip = address();
    const farm = await owner([ip]);
    // The denial itself captures the owner's networks.
    await decide(farm.accountId, "denied");
    await shared.admin`delete from auth_sessions where user_id = ${farm.userId}`;
    const later = await owner([ip]);
    expect(await decision(later.accountId)).toMatchObject(HELD);

    // A later sign-in of a denied owner is captured by the operator capture.
    const comeback = address();
    const projection = await getCanonicalHumanIdentityProjection(client.db, farm.userId);
    const binding = await getCanonicalHumanExactLoginBindingForAuthUser(client.db, {
      authUserId: farm.userId,
      providerId: "credential",
    });
    await session(farm.userId, comeback, projection, binding);
    expect((await captureFlaggedSignupNetworkOwners(ownerClient!.db)).failed).toBe(0);
    await shared.admin`delete from auth_sessions where user_id = ${farm.userId}`;
    const afterComeback = await owner([comeback]);
    expect(await decision(afterComeback.accountId)).toMatchObject(HELD);
    // Sign-ins of everyone else record nothing.
    const [others] = await shared.admin`select count(*)::int as count
      from opengeni_private.signup_network_owner_addresses
      where data_schema = ${shared.schema} and account_id = ${afterComeback.accountId}`;
    expect(others!.count).toBe(1);

    // The backfill covers a denied owner with no setup record and nothing
    // captured at decision time, like the accounts denied before 1368.
    const legacyIp = address();
    const legacy = await owner([legacyIp], { source: null });
    await decide(legacy.accountId, "denied");
    await shared.admin`delete from opengeni_private.signup_network_owner_addresses
      where data_schema = ${shared.schema} and account_id = ${legacy.accountId}`;
    await shared.admin`delete from opengeni_private.signup_network_flagged_owners
      where data_schema = ${shared.schema} and account_id = ${legacy.accountId}`;
    const before = await listSignupNetworkHolds(ownerClient!.db);
    expect(before.deniedNetworkCoverage!.capturedOwners).toBeLessThan(
      before.deniedNetworkCoverage!.flaggedAccounts,
    );
    // As the migration backfill runs it: the schema owner, outside any request.
    const captured = await captureFlaggedSignupNetworkOwners(ownerClient!.db);
    expect(captured.failed).toBe(0);
    expect(captured.capturedOwners + captured.withoutSelfServeOwner).toBe(captured.flaggedAccounts);
    const after = await listSignupNetworkHolds(ownerClient!.db);
    expect(after.deniedNetworkCoverage).toMatchObject({
      capturedOwners: after.deniedNetworkCoverage!.flaggedAccounts,
      withoutSelfServeOwner: 0,
    });
    expect(Date.parse(after.deniedNetworkCoverage!.oldestCaptureAt!)).toBeGreaterThan(0);
    const afterLegacy = await owner([legacyIp]);
    expect(await decision(afterLegacy.accountId)).toMatchObject(HELD);
  } finally {
    await configure({ deniedNetworkMode: "off" });
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);

test("holds placed by this rule never spread to further accounts", async () => {
  if (!shared || !client) return;
  await enforce();
  try {
    const farmIp = address();
    const homeIp = address();
    const farm = await owner([farmIp]);
    await decide(farm.accountId, "denied");
    // B signed up from the farm's network, then also used a home network.
    const b = await owner([farmIp, homeIp]);
    expect(await decision(b.accountId)).toMatchObject(HELD);
    // C only shares B's home network: not held, because B's hold came from
    // this rule.
    const c = await owner([homeIp]);
    expect(await decision(c.accountId)).toBeNull();
    expect(await observation(c.accountId)).toBeNull();
    // Once an operator confirms B (denied), its networks count.
    await decide(b.accountId, "denied");
    const d = await owner([homeIp]);
    expect(await decision(d.accountId)).toMatchObject(HELD);
  } finally {
    await configure({ deniedNetworkMode: "off" });
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);

test("IPv6 and IPv4-mapped sign-ins match end to end without storing the address; concurrent setups do not block", async () => {
  if (!shared || !client) return;
  await enforce();
  try {
    const v6 = "2001:db8:77:5::abcd";
    const farm = await owner([v6]);
    await decide(farm.accountId, "denied");
    const v6Later = await owner(["2001:db8:77:5:1234::1"]);
    expect(await decision(v6Later.accountId)).toMatchObject(HELD);

    const v4 = address();
    const mappedFarm = await owner([`::ffff:${v4}`]);
    await decide(mappedFarm.accountId, "denied");
    const [a, b] = await Promise.all([owner([v4]), owner([v4])]);
    expect(await decision(a!.accountId)).toMatchObject(HELD);
    expect(await decision(b!.accountId)).toMatchObject(HELD);

    const dumps = await shared.admin`select
      (select coalesce(string_agg(t::text, ' '), '') from opengeni_private.signup_network_owner_addresses t) as owners,
      (select coalesce(string_agg(t::text, ' '), '') from opengeni_private.signup_network_flagged_owners t) as flagged,
      (select coalesce(string_agg(t::text, ' '), '') from opengeni_private.promotion_detector_observations t
        where policy_version = 'denied-network-v1') as observations,
      (select coalesce(string_agg(t::text, ' '), '') from opengeni_private.promotion_decision_history t
        where policy_version = 'denied-network-v1') as history`;
    const text = JSON.stringify(dumps[0]);
    for (const raw of [v4, "2001:db8:77:5", "2001:db8:77:5::"]) expect(text).not.toContain(raw);
  } finally {
    await configure({ deniedNetworkMode: "off" });
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);

test("with both network rules enforcing, the velocity hold is kept and denied network is observed", async () => {
  if (!shared || !client) return;
  await enforce();
  await configure({ mode: "enforce", exactHoldThreshold: 2 });
  try {
    const ip = address();
    const source = signupNetwork(`both-${ip}`);
    const farm = await owner([ip], { source });
    await decide(farm.accountId, "denied");
    const next = await owner([ip], { source });
    expect(await decision(next.accountId)).toMatchObject(HELD);
    // Velocity is evaluated first and holds; the denied network rule keeps it.
    expect(await lastHistory(next.accountId)).toMatchObject({ policy_version: "ip-velocity-v1" });
    expect(await observation(next.accountId)).toMatchObject({
      deniedAccounts: 1,
      matchedVia: ["sign-in", "signup"],
    });
  } finally {
    await configure({ mode: "off", exactHoldThreshold: 3, deniedNetworkMode: "off" });
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);

test("manual decisions win and operator releases are never re-held", async () => {
  if (!shared || !client) return;
  await enforce();
  try {
    const ip = address();
    const farm = await owner([ip]);
    await decide(farm.accountId, "denied");
    const held = await owner([ip]);
    expect(await decision(held.accountId)).toMatchObject(HELD);
    await decide(held.accountId, "eligible");
    await evaluate(held.accountId);
    expect(await decision(held.accountId)).toMatchObject({
      decision: "eligible",
      actor: "operator:test",
    });
    expect(await freePlanCreditEligible(client.db, held.accountId)).toBe(true);
    // A manual decision made before evaluation is kept.
    await configure({ deniedNetworkMode: "off" });
    const manual = await owner([ip]);
    await decide(manual.accountId, "eligible");
    await configure({ deniedNetworkMode: "enforce" });
    await evaluate(manual.accountId);
    expect(await decision(manual.accountId)).toMatchObject({
      decision: "eligible",
      actor: "operator:test",
    });
  } finally {
    await configure({ deniedNetworkMode: "off" });
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);

test("invited members are never recorded, counted or held", async () => {
  if (!shared || !client) return;
  await enforce();
  try {
    const companyIp = address();
    const founder = await owner([address()]);
    // A colleague of a later-denied organization signs in from companyIp.
    const colleague = await user([companyIp]);
    await shared.admin`update auth_users set email = ${`${colleague.userId}@company.test`}
      where id = ${colleague.userId}`;
    const invitation = await createOrganizationInvitation(client.db, {
      organizationId: founder.accountId,
      actorSubjectId: `user:${founder.userId}`,
      operationId: crypto.randomUUID(),
      targetSubjectId: `user:${colleague.userId}`,
      targetEmail: `${colleague.userId}@company.test`,
      role: "member",
      expiresAt: new Date(Date.now() + DAY).toISOString(),
    });
    await acceptOrganizationInvitation(client.db, {
      organizationId: founder.accountId,
      actorSubjectId: `user:${colleague.userId}`,
      operationId: crypto.randomUUID(),
      invitationId: invitation.id,
      expectedRevision: invitation.revision,
    });
    await decide(founder.accountId, "denied");
    await owner([address()]); // capture
    const [members] = await shared.admin`select count(*)::int as count
      from opengeni_private.signup_network_owner_addresses
      where data_schema = ${shared.schema} and account_id = ${founder.accountId}`;
    expect(members!.count).toBe(1); // the founder's own network only
    const sameAsColleague = await owner([companyIp]);
    expect(await decision(sameAsColleague.accountId)).toBeNull();
  } finally {
    await configure({ deniedNetworkMode: "off" });
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);

test("an unexpected failure never blocks setup, Free eligibility or admission", async () => {
  if (!shared || !client) return;
  await enforce();
  const evaluateName = "opengeni_private.evaluate_signup_denied_network(uuid)";
  const captureName = "opengeni_private.capture_flagged_owner_session_networks(text,uuid)";
  const hashName = "opengeni_private.signup_network_session_hash(text,text)";
  const [evaluateBody] =
    await shared.admin`select pg_get_functiondef(${evaluateName}::regprocedure) as body`;
  const [captureBody] =
    await shared.admin`select pg_get_functiondef(${captureName}::regprocedure) as body`;
  const [hashBody] =
    await shared.admin`select pg_get_functiondef(${hashName}::regprocedure) as body`;
  const ip = address();
  const farm = await owner([ip]);
  await decide(farm.accountId, "denied");
  await shared.admin
    .unsafe(`CREATE OR REPLACE FUNCTION opengeni_private.evaluate_signup_denied_network(p_account_id uuid)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
    BEGIN RAISE EXCEPTION 'detector broken' USING ERRCODE = 'XX000'; END $$`);
  await shared.admin
    .unsafe(`CREATE OR REPLACE FUNCTION opengeni_private.capture_flagged_owner_session_networks(p_data_schema text, p_account_id uuid)
    RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog AS $$
    BEGIN RAISE EXCEPTION 'capture broken' USING ERRCODE = 'XX000'; END $$`);
  await shared.admin
    .unsafe(`CREATE OR REPLACE FUNCTION opengeni_private.signup_network_session_hash(p_data_schema text, p_address text)
    RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
    BEGIN RAISE EXCEPTION 'hash broken' USING ERRCODE = 'XX000'; END $$`);
  try {
    const created = await owner([ip]);
    expect(await decision(created.accountId)).toBeNull();
    expect(await freePlanCreditEligible(client.db, created.accountId)).toBe(true);
    await getSpendableCreditBalance(client.db, created.accountId);
    // Decisions and a flagged owner's sign-in still succeed.
    await decide(created.accountId, "denied");
    const projection = await getCanonicalHumanIdentityProjection(client.db, farm.userId);
    const binding = await getCanonicalHumanExactLoginBindingForAuthUser(client.db, {
      authUserId: farm.userId,
      providerId: "credential",
    });
    await session(farm.userId, address(), projection, binding);
  } finally {
    await shared.admin.unsafe(evaluateBody!.body as string);
    await shared.admin.unsafe(captureBody!.body as string);
    await shared.admin.unsafe(hashBody!.body as string);
    await configure({ deniedNetworkMode: "off" });
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);

test("review lists denied network holds with their own reason; release by rule", async () => {
  if (!shared || !client || !ownerClient) return;
  await releaseSignupNetworkHolds(ownerClient.db, {
    operator: "operator:test",
    reason: "reset before review test",
  });
  await enforce();
  try {
    const ip = address();
    const farm = await owner([ip]);
    await decide(farm.accountId, "denied");
    const held = await owner([ip]);
    const listed = await listSignupNetworkHolds(ownerClient.db);
    expect(listed.schemaVersion).toBe(2);
    expect(listed.policyVersions).toEqual(["ip-velocity-v1", "denied-network-v1"]);
    expect(listed.settings.deniedNetworkMode).toBe("enforce");
    expect(listed.accounts.map((account) => account.accountId)).toEqual([held.accountId]);
    expect(listed.accounts[0]).toMatchObject({
      policyVersion: "denied-network-v1",
      ruleId: "denied-network-exact-v1",
      reason: "Network used in the last 90 days by a denied or currently held account",
      addressGroup: null,
      emailDomain: "example.test",
      deniedNetwork: {
        deniedAccounts: 1,
        heldAccounts: 0,
        matchedVia: ["sign-in"],
        matchedAccountIds: [farm.accountId],
      },
      unreadable: [],
    });
    expect(listed.groups).toEqual([]);
    expect(JSON.stringify(listed)).not.toContain(ip);
    const velocityOnly = await releaseSignupNetworkHolds(ownerClient.db, {
      operator: "operator:test",
      reason: "release velocity holds only",
      policyVersions: ["ip-velocity-v1"],
      dryRun: true,
    });
    expect(velocityOnly.candidates).toBe(0);
    const released = await releaseSignupNetworkHolds(ownerClient.db, {
      operator: "operator:test",
      reason: "release denied network holds",
      policyVersions: ["denied-network-v1"],
    });
    expect(released.released.map((entry) => entry.accountId)).toEqual([held.accountId]);
    expect(await decision(held.accountId)).toMatchObject({
      decision: "eligible",
      actor: "operator:test",
    });
  } finally {
    await configure({ deniedNetworkMode: "off" });
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);

test("settings are owner-only and validated; runtime roles cannot read keys, hashes or call the rule", async () => {
  if (!shared || !client || !ownerClient) return;
  const current = await settings();
  expect(
    await sqlState(() =>
      setSignupNetworkVelocitySettings(ownerClient!.db, {
        changes: { deniedNetworkMode: "sometimes" as "off" },
        operator: "operator:test",
        reason: "invalid mode test",
        expectedRevision: current.revision,
      }),
    ),
  ).toBe("23514");
  const changed = await configure({ deniedNetworkMode: "observe" });
  expect(changed.previous.deniedNetworkMode).toBe("off");
  expect(changed.current).toMatchObject({ deniedNetworkMode: "observe", mode: "off" });
  await configure({ deniedNetworkMode: "off" });
  for (const statement of [
    sql`select * from opengeni_private.signup_network_session_keys`,
    sql`select * from opengeni_private.signup_network_owner_addresses`,
    sql`select * from opengeni_private.signup_network_flagged_owners`,
    sql`select * from opengeni_private.signup_network_owner_setups`,
    sql`select opengeni_private.signup_network_session_hash('x', '198.51.100.1')`,
    sql`select opengeni_private.signup_network_exact_unit('198.51.100.1')`,
    sql`select opengeni_private.evaluate_signup_denied_network(gen_random_uuid())`,
    sql`select opengeni_private.capture_flagged_owner_session_networks('x', gen_random_uuid())`,
    sql`select opengeni_private.capture_all_flagged_owner_session_networks('x')`,
    sql`select opengeni_private.record_signup_owner_session_networks('x', gen_random_uuid(), 'x')`,
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
