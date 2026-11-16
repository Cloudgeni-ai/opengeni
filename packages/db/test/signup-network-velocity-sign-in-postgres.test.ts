import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  acceptOrganizationInvitation,
  completeSelfServiceOrganizationSetupWithSignupNetwork,
  createDb,
  createManagedOrganizationWithSignupNetwork,
  createOrganizationInvitation,
  evaluateSignupNetworkAccounts,
  freePlanCreditEligible,
  listSignupNetworkHolds,
  nestedPostgresSqlState,
  readSignupNetworkVelocitySettings,
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

// Migration 1471: signup network velocity on the owners' sign-in networks,
// and organizations set up through the legacy POST /v1/organizations route.
// Synthetic accounts, documentation addresses (RFC 5737) and synthetic
// signup hashes only.
let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
let ownerClient: DbClient | null = null;
const DAY = 86_400_000;

beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase("signup-velocity-sign-in", "velocity_signin");
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
let counter = 0;
/** A unique synthetic signup network (a rotating request address). */
function rotating(): SignupNetworkSource {
  counter += 1;
  return {
    addressHash: hex(`address:rotating-${counter}`),
    prefixHash: hex(`prefix:rotating-${counter}`),
  };
}
/** A unique documentation IPv4 address (TEST-NET-2 and TEST-NET-3). */
function address() {
  counter += 1;
  return `${counter < 250 ? "198.51.100" : "203.0.113"}.${counter % 250}`;
}

async function user(addresses: string[], ageDays = 0) {
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
  const created = { userId, projection, binding };
  for (const ip of addresses) await session(created, ip, ageDays);
  return created;
}
type User = Awaited<ReturnType<typeof user>>;
async function session(
  member: Pick<User, "projection" | "binding"> & { userId: string },
  ip: string,
  ageDays = 0,
) {
  await shared!.admin`insert into auth_sessions (
      id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at,
      identity_id, identity_revision, auth_revision, login_binding_id, login_binding_revision
    ) values (
      ${crypto.randomUUID()}, ${member.userId}, ${crypto.randomUUID()}, now() + interval '7 days', ${ip},
      'Test browser', now() - ${`${ageDays} days`}::interval, now() - ${`${ageDays} days`}::interval,
      ${member.projection!.activeIdentity!.id}, ${member.projection!.activeIdentity!.identityRevision},
      ${member.projection!.activeIdentity!.authRevision}, ${member.binding!.id}, ${member.binding!.revision}
    )`;
}

type Owner = { accountId: string; userId: string; evaluateAccountIds: string[] };

/** Evaluates like the API after commit; failures fail the test. */
async function evaluate(accountIds: string[]) {
  const failures: unknown[] = [];
  await evaluateSignupNetworkAccounts(client!.db, accountIds, (_id, error) => failures.push(error));
  expect(failures).toEqual([]);
}

/** A new owner signed in from `addresses` who sets up through onboarding. */
async function owner(
  addresses: string[],
  options: { source?: SignupNetworkSource | null; ageDays?: number } = {},
): Promise<Owner> {
  const { userId } = await user(addresses, options.ageDays);
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
  await evaluate(evaluateAccountIds);
  return { accountId: setup.organizationId, userId, evaluateAccountIds };
}

/** A new owner signed in from `addresses` who sets up through POST /v1/organizations. */
async function legacyOwner(
  addresses: string[],
  source: SignupNetworkSource | null = null,
): Promise<Owner> {
  const { userId } = await user(addresses);
  const { organization, evaluateAccountIds } = await createManagedOrganizationWithSignupNetwork(
    client!.db,
    {
      subjectId: `user:${userId}`,
      subjectLabel: "Network owner",
      name: "Legacy organization",
      operationId: crypto.randomUUID(),
      trialCreditsEnabled: true,
      trialCreditModelIds: ["model-a"],
      signupNetwork: source,
    },
  );
  await evaluate(evaluateAccountIds);
  return { accountId: organization.organization.id, userId, evaluateAccountIds };
}

async function configure(changes: SignupNetworkVelocityChanges) {
  const current = await readSignupNetworkVelocitySettings(ownerClient!.db);
  await setSignupNetworkVelocitySettings(ownerClient!.db, {
    changes,
    operator: "operator:test",
    reason: "sign-in velocity test",
    expectedRevision: current.revision,
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
    where data_schema = ${shared!.schema} and account_id = ${accountId} and policy_version = 'ip-velocity-v1'`;
  return (row?.evidence ?? null) as Record<string, unknown> | null;
}
async function lastHistory(accountId: string) {
  const [row] = await shared!.admin`select policy_version, rule_id
    from opengeni_private.promotion_decision_history where data_schema = ${shared!.schema}
    and account_id = ${accountId} order by revision desc limit 1`;
  return row ?? null;
}
async function enforce() {
  await shared!
    .admin`select opengeni_private.set_promotion_enforcement(true,'test','sign-in velocity test',true)`;
  await configure({ mode: "enforce" });
}
async function reset() {
  await configure({ mode: "off", rateLimitEnabled: false, exactHoldThreshold: 3 });
  await shared!.admin`update promotion_enforcement set enabled=false`;
}
const HELD = { decision: "held", actor: "service:promotion-detector" };

// Tests share one database and run in order.
test("loopback, unspecified and link-local sign-in addresses are never a network", async () => {
  if (!shared) return;
  const [units] = await shared.admin`select
    opengeni_private.signup_network_exact_unit('127.0.0.1') as loopback,
    opengeni_private.signup_network_exact_unit('127.8.9.10') as loopback8,
    opengeni_private.signup_network_exact_unit('::ffff:127.0.0.1') as mapped,
    opengeni_private.signup_network_exact_unit('::1') as v6loopback,
    opengeni_private.signup_network_exact_unit('::') as unspecified,
    opengeni_private.signup_network_exact_unit('0.0.0.0') as unspecified4,
    opengeni_private.signup_network_exact_unit('169.254.1.2') as linklocal,
    opengeni_private.signup_network_exact_unit('fe80::1') as v6linklocal,
    opengeni_private.signup_network_exact_unit('::ffff:198.51.100.7') as public`;
  expect(units).toEqual({
    loopback: null,
    loopback8: null,
    mapped: null,
    v6loopback: null,
    unspecified: null,
    unspecified4: null,
    linklocal: null,
    v6linklocal: null,
    public: "198.51.100.7",
  });
});

test("off records sign-in networks for every setup path but evaluates nothing", async () => {
  if (!shared || !client) return;
  const ip = address();
  const created = [await owner([ip]), await legacyOwner([ip]), await legacyOwner([ip])];
  for (const one of created) {
    expect(one.evaluateAccountIds).toEqual([]);
    expect(await decision(one.accountId)).toBeNull();
    expect(await observation(one.accountId)).toBeNull();
  }
  const [rows] = await shared.admin`select count(*)::int as count
    from opengeni_private.signup_network_owner_setups
    where data_schema = ${shared.schema} and account_id = any(${created.map((one) => one.accountId)}::uuid[])`;
  expect(rows!.count).toBe(3);
}, 180_000);

test("legacy organization creation records the signup network and its rate limit refuses the sixth", async () => {
  if (!shared || !client) return;
  await configure({ rateLimitEnabled: true });
  try {
    const source = rotating();
    for (let i = 0; i < 5; i++) await legacyOwner([address()], source);
    const [recorded] = await shared.admin`select count(*)::int as count
      from opengeni_private.signup_network_sources
      where data_schema = ${shared.schema} and address_hash = ${source.addressHash}`;
    expect(recorded!.count).toBe(5);
    let refused: string | null = null;
    try {
      await legacyOwner([address()], source);
    } catch (error) {
      refused = nestedPostgresSqlState(error) ?? null;
    }
    expect(refused).toBe("OG429");
    // Another network is unaffected.
    await legacyOwner([address()], rotating());
  } finally {
    await reset();
  }
}, 180_000);

test("enforce holds the third organization whose owner signed in from one network, and the earlier ones, whatever the setup path or signup network", async () => {
  if (!shared || !client) return;
  await enforce();
  try {
    const farmIp = address();
    // Rotating signup addresses, one shared sign-in network, both routes.
    const first = await legacyOwner([farmIp]);
    expect(first.evaluateAccountIds).toEqual([first.accountId]);
    const second = await owner([farmIp], { source: rotating() });
    expect(await decision(first.accountId)).toBeNull();
    expect(await decision(second.accountId)).toBeNull();
    expect(await observation(second.accountId)).toMatchObject({
      ruleId: "ip-velocity-observed-v1",
      exactGroupSize: 1,
      signInGroupSize: 2,
    });
    const third = await legacyOwner([farmIp]);
    // This organization first, then the same-network ones, newest first.
    expect(third.evaluateAccountIds).toEqual([third.accountId, second.accountId, first.accountId]);
    for (const one of [first, second, third]) {
      expect(await decision(one.accountId)).toMatchObject(HELD);
      expect(await lastHistory(one.accountId)).toMatchObject({
        policy_version: "ip-velocity-v1",
        rule_id: "ip-velocity-sign-in-v1",
      });
    }
    const evidence = (await observation(third.accountId))!;
    expect(evidence).toMatchObject({
      ruleId: "ip-velocity-sign-in-v1",
      signInGroupSize: 3,
      exactGroupSize: 0,
      addressGroup: null,
      exactHoldThreshold: 3,
    });
    expect(String(evidence.signInGroup)).toMatch(/^[0-9a-f]{16}$/);
    expect(evidence.signInGroupSetupTimes).toHaveLength(3);
    // Keyed hashes only: no address anywhere in the evidence.
    expect(JSON.stringify(evidence)).not.toContain(farmIp);
    expect(await freePlanCreditEligible(client.db, third.accountId)).toBe(false);
    // An owner from another network is unaffected.
    const other = await legacyOwner([address()]);
    expect(await decision(other.accountId)).toBeNull();
    // Review lists the sign-in group.
    const holds = await listSignupNetworkHolds(ownerClient!.db);
    const listed = holds.accounts.find((account) => account.accountId === third.accountId);
    expect(listed).toMatchObject({ ruleId: "ip-velocity-sign-in-v1", signInGroupSize: 3 });
    expect(listed!.signInGroup).toBe(evidence.signInGroup as string);
  } finally {
    await reset();
  }
}, 180_000);

test("a sign-in after setup counts; an old sign-in from the network does not", async () => {
  if (!shared || !client) return;
  await enforce();
  try {
    const ip = address();
    // Signed in from the network three days before setting up: not counted.
    const stale = await owner([ip], { ageDays: 3 });
    const a = await owner([ip]);
    // Set up from elsewhere, then signs in from the network afterwards.
    const laterUser = await owner([address()]);
    expect(await observation(a.accountId)).toBeNull();
    const projection = await getCanonicalHumanIdentityProjection(client.db, laterUser.userId);
    const binding = await getCanonicalHumanExactLoginBindingForAuthUser(client.db, {
      authUserId: laterUser.userId,
      providerId: "credential",
    });
    await session({ userId: laterUser.userId, projection, binding }, ip);
    await evaluate([laterUser.accountId]);
    expect(await observation(laterUser.accountId)).toMatchObject({ signInGroupSize: 2 });
    const third = await owner([ip]);
    expect(await decision(third.accountId)).toMatchObject(HELD);
    expect(await decision(a.accountId)).toMatchObject(HELD);
    expect(await decision(laterUser.accountId)).toMatchObject(HELD);
    expect(await decision(stale.accountId)).toBeNull();
  } finally {
    await reset();
  }
}, 180_000);

test("observe records without holding; manual decisions win and operator releases are never re-held", async () => {
  if (!shared || !client) return;
  await configure({ mode: "observe" });
  const ip = address();
  const observed = [await legacyOwner([ip]), await legacyOwner([ip]), await legacyOwner([ip])];
  for (const one of observed) expect(await decision(one.accountId)).toBeNull();
  expect(await observation(observed[2]!.accountId)).toMatchObject({
    ruleId: "ip-velocity-sign-in-v1",
    signInGroupSize: 3,
  });
  await enforce();
  try {
    await decide(observed[0]!.accountId, "eligible");
    await evaluate(observed.map((one) => one.accountId));
    expect(await decision(observed[0]!.accountId)).toMatchObject({
      decision: "eligible",
      actor: "operator:test",
    });
    expect(await decision(observed[1]!.accountId)).toMatchObject(HELD);
    await decide(observed[1]!.accountId, "eligible");
    await evaluate([observed[1]!.accountId]);
    expect(await decision(observed[1]!.accountId)).toMatchObject({
      decision: "eligible",
      actor: "operator:test",
    });
  } finally {
    await reset();
  }
}, 180_000);

test("invited members signing in from the network are never counted", async () => {
  if (!shared || !client) return;
  await enforce();
  try {
    const officeIp = address();
    const founder = await owner([officeIp]);
    for (let i = 0; i < 3; i++) {
      const colleague = await user([officeIp]);
      const email = `${colleague.userId}@company.test`;
      await shared.admin`update auth_users set email = ${email} where id = ${colleague.userId}`;
      const invitation = await createOrganizationInvitation(client.db, {
        organizationId: founder.accountId,
        actorSubjectId: `user:${founder.userId}`,
        operationId: crypto.randomUUID(),
        targetSubjectId: `user:${colleague.userId}`,
        targetEmail: email,
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
    }
    const second = await owner([officeIp]);
    await evaluate([founder.accountId, second.accountId]);
    expect(await decision(founder.accountId)).toBeNull();
    expect(await decision(second.accountId)).toBeNull();
    expect(await observation(second.accountId)).toMatchObject({ signInGroupSize: 2 });
  } finally {
    await reset();
  }
}, 180_000);
