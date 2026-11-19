import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  completeSelfServiceOrganizationSetupWithSignupNetwork,
  createAdditionalManagedOrganizationWithSignupNetwork,
  createDb,
  evaluateSignupNetworkAccounts,
  getSpendableCreditBalance,
  listSignupNetworkHolds,
  readSignupNetworkVelocitySettings,
  releaseSignupNetworkHolds,
  resetSandboxPersonStandingCache,
  resolveSandboxComputeStanding,
  setSignupNetworkVelocitySettings,
  type DbClient,
  type SignupMailSignal,
  type SignupNetworkSource,
  type SignupNetworkVelocityChanges,
} from "../src";
import { DEFAULT_SANDBOX_PLAN_LIMITS } from "@opengeni/config";
import {
  ensureCanonicalHumanIdentityForAuthUser,
  synchronizeCanonicalHumanLoginBindings,
} from "../src/canonical-human-identities";

// Migration 1489: email clusters (rule email-cluster-v1). Synthetic accounts
// with synthetic mail domains only.
let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
let ownerClient: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase("signup-email-cluster", "email_cluster");
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

const unique = () => crypto.randomUUID().slice(0, 8);

async function user(domain: string) {
  const userId = crypto.randomUUID();
  await shared!.admin`insert into auth_users(id,name,email,email_verified)
    values (${userId},'Cluster owner',${`${userId.slice(0, 12)}@${domain}`},true)`;
  await shared!
    .admin`insert into auth_identities (id, user_id, account_id, provider_id, created_at, updated_at)
    values (${crypto.randomUUID()}, ${userId}, ${userId}, 'credential', now(), now())`;
  await ensureCanonicalHumanIdentityForAuthUser(client!.db, userId);
  await synchronizeCanonicalHumanLoginBindings(client!.db, userId);
  return userId;
}

type Owner = { accountId: string; userId: string; evaluateAccountIds: string[] };

async function evaluate(accountIds: string[]) {
  const failures: unknown[] = [];
  await evaluateSignupNetworkAccounts(client!.db, accountIds, (_id, error) => failures.push(error));
  expect(failures).toEqual([]);
}

const hex = (label: string) => new Bun.CryptoHasher("sha256").update(label).digest("hex");
/** A synthetic signup network with its own exact and prefix hashes. */
function network(name: string): SignupNetworkSource {
  return { addressHash: hex(`address:${name}`), prefixHash: hex(`prefix:${name}`) };
}

/** A new owner with a mail address at `domain` who sets up through onboarding. */
async function owner(
  domain: string,
  signupNetwork: SignupNetworkSource | null = null,
  signupMailSignal: SignupMailSignal | null = null,
): Promise<Owner> {
  const userId = await user(domain);
  const { setup, evaluateAccountIds } = await completeSelfServiceOrganizationSetupWithSignupNetwork(
    client!.db,
    {
      authUserId: userId,
      actorSubjectId: `user:${userId}`,
      organizationName: "Cluster organization",
      operationId: crypto.randomUUID(),
      requestFingerprint: "a".repeat(64),
      trialCreditsEnabled: true,
      trialCreditModelIds: ["model-a"],
      signupNetwork,
      signupMailSignal,
    },
  );
  await evaluate(evaluateAccountIds);
  return { accountId: setup.organizationId, userId, evaluateAccountIds };
}

async function additional(
  userId: string,
  signupMailSignal: SignupMailSignal | null = null,
): Promise<Owner> {
  const { organization, evaluateAccountIds } =
    await createAdditionalManagedOrganizationWithSignupNetwork(client!.db, {
      subjectId: `user:${userId}`,
      subjectLabel: "Cluster owner",
      name: `Extra ${unique()}`,
      workspaceName: "Team",
      operationId: crypto.randomUUID(),
      signupNetwork: null,
      signupMailSignal,
    });
  await evaluate(evaluateAccountIds);
  return { accountId: organization.organization.id, userId, evaluateAccountIds };
}

async function configure(changes: SignupNetworkVelocityChanges) {
  const current = await readSignupNetworkVelocitySettings(ownerClient!.db);
  await setSignupNetworkVelocitySettings(ownerClient!.db, {
    changes,
    operator: "operator:test",
    reason: "email cluster test",
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
async function lastHistory(accountId: string) {
  const [row] = await shared!.admin`select policy_version, rule_id, evidence
    from opengeni_private.promotion_decision_history where data_schema = ${shared!.schema}
    and account_id = ${accountId} order by revision desc limit 1`;
  return row ?? null;
}
async function observation(accountId: string) {
  const [row] = await shared!
    .admin`select evidence from opengeni_private.promotion_detector_observations
    where data_schema = ${shared!.schema} and account_id = ${accountId} and policy_version = 'email-cluster-v1'`;
  return (row?.evidence ?? null) as Record<string, unknown> | null;
}
/** Moves recorded setups back in time so later tests start a fresh window. */
async function age(owners: Owner[], seconds: number) {
  await shared!.admin`update opengeni_private.signup_owner_email_domains
    set set_up_at = set_up_at - ${`${seconds} seconds`}::interval
    where data_schema = ${shared!.schema}
      and account_id = any(${owners.map((one) => one.accountId)}::uuid[])`;
}
const HELD = { decision: "held", actor: "service:promotion-detector" };
// One leg at a time: the others off.
const ONLY_DOMAIN: SignupNetworkVelocityChanges = {
  emailDomainMode: "enforce",
  burstMode: "off",
  deniedDomainMode: "off",
  disposableMailMode: "off",
  slowDomainMode: "off",
};
const ONLY_BURST: SignupNetworkVelocityChanges = {
  emailDomainMode: "off",
  burstMode: "enforce",
  deniedDomainMode: "off",
  disposableMailMode: "off",
  slowDomainMode: "off",
};
const ONLY_DENIED: SignupNetworkVelocityChanges = {
  emailDomainMode: "off",
  burstMode: "off",
  deniedDomainMode: "enforce",
  disposableMailMode: "off",
  slowDomainMode: "off",
};
const ONLY_DISPOSABLE: SignupNetworkVelocityChanges = {
  emailDomainMode: "off",
  burstMode: "off",
  deniedDomainMode: "off",
  disposableMailMode: "enforce",
  slowDomainMode: "off",
};
const ONLY_SLOW: SignupNetworkVelocityChanges = {
  emailDomainMode: "off",
  burstMode: "off",
  deniedDomainMode: "off",
  disposableMailMode: "off",
  slowDomainMode: "enforce",
};
const DEFAULTS: SignupNetworkVelocityChanges = {
  emailDomainMode: "observe",
  emailDomainHoldThreshold: 3,
  emailDomainWindowMinutes: 60,
  burstMode: "enforce",
  burstHoldThreshold: 4,
  burstWindowSeconds: 10,
  deniedDomainMode: "enforce",
  deniedDomainHoldThreshold: 2,
  deniedDomainLookbackDays: 30,
  disposableMailMode: "enforce",
  slowDomainMode: "enforce",
  slowDomainHoldThreshold: 3,
  slowDomainWindowHours: 24,
};

// Tests share one database and run in order.
test("mail domains are classed and the legs default to burst and denied enforce, domain observe", async () => {
  if (!shared) return;
  const [kinds] = await shared.admin`select
    opengeni_private.signup_email_domain_kind('gmail.com') as gmail,
    opengeni_private.signup_email_domain_kind('Outlook.CO.UK') as outlook,
    opengeni_private.signup_email_domain_kind('proton.me') as proton,
    opengeni_private.signup_email_domain_kind('posteo.de') as posteo,
    opengeni_private.signup_email_domain_kind('xs4all.nl') as xs4all,
    opengeni_private.signup_email_domain_kind('slmail.me') as simplelogin,
    opengeni_private.signup_email_domain_kind('privaterelay.appleid.com') as apple,
    opengeni_private.signup_email_domain_kind('duck.com') as duck,
    opengeni_private.signup_email_domain_kind('mozmail.com') as mozmail,
    opengeni_private.signup_email_domain_kind('addy.io') as addy,
    opengeni_private.signup_email_domain_kind('someone.addy.io') as personal,
    opengeni_private.signup_email_domain_kind('mail.someone.freeddns.org') as dynamic_dns,
    opengeni_private.signup_email_domain_kind('someone.duckdns.org') as duckdns,
    opengeni_private.signup_email_domain_kind('mywire.org') as dynamic_dns_host,
    opengeni_private.signup_email_domain_kind('googlemail.com') as googlemail,
    opengeni_private.signup_email_domain_provider('mail.someone.freeddns.org') as dynamic_dns_provider,
    opengeni_private.signup_email_domain_provider('someone.addy.io') as personal_provider,
    opengeni_private.signup_email_domain_provider('slmail.me') as relay_provider,
    opengeni_private.signup_email_domain_provider('acme-robotics.io') as company_provider,
    opengeni_private.signup_email_domain_kind('cs.uni-example.edu') as edu,
    opengeni_private.signup_email_domain_kind('ox.ac.uk') as ac,
    opengeni_private.signup_email_domain_kind('example.test') as test,
    opengeni_private.signup_email_domain_kind('invalid.invalid') as invalid,
    opengeni_private.signup_email_domain_kind('mail.example.com') as example,
    opengeni_private.signup_email_domain_kind('acme-robotics.io') as company,
    opengeni_private.signup_email_domain_kind(null) as missing,
    opengeni_private.signup_email_domain_key('Someone.Addy.IO.') as personal_key`;
  expect(kinds).toEqual({
    gmail: "public",
    outlook: "public",
    proton: "public",
    posteo: "public",
    xs4all: "public",
    simplelogin: "relay",
    apple: "relay",
    duck: "relay",
    mozmail: "relay",
    addy: "relay",
    personal: "personal_relay",
    dynamic_dns: "personal_relay",
    duckdns: "personal_relay",
    dynamic_dns_host: "unknown",
    googlemail: "public",
    dynamic_dns_provider: "freeddns.org",
    personal_provider: "addy.io",
    relay_provider: "slmail.me",
    company_provider: null,
    edu: "academic",
    ac: "academic",
    test: "reserved",
    invalid: "reserved",
    example: "reserved",
    company: "company",
    missing: "unknown",
    personal_key: "someone.addy.io",
  });
  const settings = await readSignupNetworkVelocitySettings(ownerClient!.db);
  expect(settings).toMatchObject(DEFAULTS);
});

test("owners at reserved domains are recorded but never evaluated or counted", async () => {
  if (!shared || !client) return;
  const created: Owner[] = [];
  for (let index = 0; index < 5; index += 1) created.push(await owner("example.test"));
  for (const one of created) {
    expect(one.evaluateAccountIds).toEqual([]);
    expect(await decision(one.accountId)).toBeNull();
  }
  const [row] = await shared.admin`select count(*)::int as count,
      count(*) filter (where domain_kind = 'reserved' and domain_hash is null)::int as reserved
    from opengeni_private.signup_owner_email_domains
    where data_schema = ${shared.schema} and account_id = any(${created.map((one) => one.accountId)}::uuid[])`;
  expect(row).toEqual({ count: 5, reserved: 5 });
}, 180_000);

test("domain leg: observed by default, and when enforced the third owner of one company domain holds the group", async () => {
  if (!shared || !client) return;
  await configure({
    ...DEFAULTS,
    burstMode: "off",
    deniedDomainMode: "off",
    slowDomainMode: "off",
  });
  const observedDomain = `colleagues-${unique()}.com`;
  const colleagues = [
    await owner(observedDomain),
    await owner(observedDomain),
    await owner(observedDomain),
  ];
  for (const one of colleagues) expect(await decision(one.accountId)).toBeNull();
  expect(await observation(colleagues[2]!.accountId)).toMatchObject({
    ruleId: "email-domain-v1",
    emailDomainMode: "observe",
    domainKind: "company",
    domainGroupSize: 3,
  });
  await age(colleagues, 7200);

  await configure(ONLY_DOMAIN);
  const domain = `farm-${unique()}.com`;
  const first = await owner(domain);
  const second = await owner(domain);
  expect(first.evaluateAccountIds).toEqual([first.accountId]);
  expect(second.evaluateAccountIds[0]).toBe(second.accountId);
  expect(second.evaluateAccountIds).toContain(first.accountId);
  expect(await decision(first.accountId)).toBeNull();
  expect(await decision(second.accountId)).toBeNull();
  expect(await observation(second.accountId)).toMatchObject({
    ruleId: "email-cluster-observed-v1",
    domainGroupSize: 2,
  });
  const third = await owner(domain);
  for (const one of [first, second, third]) {
    expect(await decision(one.accountId)).toMatchObject(HELD);
    expect(await lastHistory(one.accountId)).toMatchObject({
      policy_version: "email-cluster-v1",
      rule_id: "email-domain-v1",
    });
  }
  const evidence = (await lastHistory(third.accountId))!.evidence as Record<string, unknown>;
  expect(evidence.domainGroupSize).toBe(3);
  expect(String(evidence.domainGroup)).toMatch(/^[0-9a-f]{16}$/);
  expect(JSON.stringify(evidence)).not.toContain(domain);

  const publicOwners: Owner[] = [];
  for (let index = 0; index < 4; index += 1) publicOwners.push(await owner("gmail.com"));
  for (const one of publicOwners) expect(await decision(one.accountId)).toBeNull();
  await age([first, second, third, ...publicOwners], 7200);
}, 180_000);

test("domain leg: shared relays and academic domains never group, a personal relay groups on its subdomain, one person counts once", async () => {
  if (!shared || !client) return;
  await configure(ONLY_DOMAIN);
  const shared_relay = [
    await owner("slmail.me"),
    await owner("slmail.me"),
    await owner("slmail.me"),
  ];
  const apple = [
    await owner("privaterelay.appleid.com"),
    await owner("privaterelay.appleid.com"),
    await owner("privaterelay.appleid.com"),
  ];
  const academic = [
    await owner("cs.uni-example.edu"),
    await owner("cs.uni-example.edu"),
    await owner("cs.uni-example.edu"),
  ];
  const otherPeople = [
    await owner("a1.addy.io"),
    await owner("b2.addy.io"),
    await owner("c3.addy.io"),
  ];
  for (const one of [...shared_relay, ...apple, ...academic, ...otherPeople])
    expect(await decision(one.accountId)).toBeNull();
  const subdomain = `p${unique()}.anonaddy.me`;
  const onePerson = [await owner(subdomain), await owner(subdomain), await owner(subdomain)];
  for (const one of onePerson) expect(await decision(one.accountId)).toMatchObject(HELD);

  const domain = `team-${unique()}.dev`;
  const founder = await owner(domain);
  const extra = [await additional(founder.userId), await additional(founder.userId)];
  expect(extra[0]!.evaluateAccountIds[0]).toBe(extra[0]!.accountId);
  for (const one of [founder, extra[0]!]) expect(await decision(one.accountId)).toBeNull();
  // The second additional organization within a day is held by its own rule
  // (1491), never by the domain leg: one person counts once.
  expect(await lastHistory(extra[1]!.accountId)).toMatchObject({
    policy_version: "additional-organization-v1",
  });
  // A colleague's own organization is the second owner, still under three.
  const colleague = await owner(domain);
  expect(await decision(colleague.accountId)).toBeNull();
  await age(
    [
      ...shared_relay,
      ...apple,
      ...academic,
      ...otherPeople,
      ...onePerson,
      founder,
      ...extra,
      colleague,
    ],
    7200,
  );
}, 180_000);

test("burst leg: unrelated, network-only and domain-only bursts are observed; one relay, or one domain on one network, holds every member", async () => {
  if (!shared || !client) return;
  await configure(ONLY_BURST);
  const unrelated: Owner[] = [];
  for (let index = 0; index < 3; index += 1) unrelated.push(await owner(`solo-${unique()}.net`));
  unrelated.push(await owner("outlook.com"));
  for (const one of unrelated) expect(await decision(one.accountId)).toBeNull();
  expect(await observation(unrelated[3]!.accountId)).toMatchObject({
    ruleId: "email-cluster-observed-v1",
    burstGroupSize: 4,
    relatedBurstGroupSize: 1,
  });
  await age(unrelated, 7200);

  // The same-second batch through one shared relay.
  const relayBurst: Owner[] = [];
  for (let index = 0; index < 3; index += 1) relayBurst.push(await owner("slmail.me"));
  for (const one of relayBurst) expect(await decision(one.accountId)).toBeNull();
  relayBurst.push(await owner("slmail.me"));
  for (const one of relayBurst) {
    expect(await decision(one.accountId)).toMatchObject(HELD);
    expect(await lastHistory(one.accountId)).toMatchObject({ rule_id: "signup-burst-v1" });
  }
  const holds = await listSignupNetworkHolds(ownerClient!.db);
  const listed = holds.accounts.find((account) => account.accountId === relayBurst[0]!.accountId);
  expect(listed?.policyVersion).toBe("email-cluster-v1");
  expect(listed?.emailCluster?.relatedBurstGroupSize).toBe(4);
  // Release is the ordinary bulk release of the rule.
  const released = await releaseSignupNetworkHolds(ownerClient!.db, {
    policyVersions: ["email-cluster-v1"],
    operator: "operator:test",
    reason: "test rollback",
  });
  expect(released.released.length).toBeGreaterThanOrEqual(4);
  for (const one of relayBurst)
    expect(await decision(one.accountId)).toMatchObject({ decision: "eligible" });
  // An operator release is never held again.
  await evaluate(relayBurst.map((one) => one.accountId));
  for (const one of relayBurst)
    expect(await decision(one.accountId)).toMatchObject({ decision: "eligible" });
  await age(relayBurst, 7200);

  // Public domains, one signup network (a workshop on one venue network):
  // observed, never held.
  const shared_network = network(`burst-${unique()}`);
  const networkBurst: Owner[] = [];
  for (const domain of ["gmail.com", "outlook.com", "yahoo.com", "icloud.com"])
    networkBurst.push(await owner(domain, shared_network));
  for (const one of networkBurst) expect(await decision(one.accountId)).toBeNull();
  expect(await observation(networkBurst[3]!.accountId)).toMatchObject({
    ruleId: "signup-burst-v1",
    relatedBurstGroupSize: 4,
    enforceableBurstGroupSize: 1,
  });
  await age(networkBurst, 7200);

  // One company or academic domain from different networks (an office
  // onboarding colleagues, a classroom): observed, never held.
  for (const domain of [`office-${unique()}.dev`, `cs.uni-${unique()}.edu`]) {
    const domainBurst: Owner[] = [];
    for (let index = 0; index < 4; index += 1)
      domainBurst.push(await owner(domain, network(`office-${unique()}`)));
    for (const one of domainBurst) expect(await decision(one.accountId)).toBeNull();
    await age(domainBurst, 7200);
  }

  // Different per-person names of one dynamic DNS host, from different
  // networks, in the same seconds: a farm rotating names, held.
  const dynamicBurst: Owner[] = [];
  for (let index = 0; index < 4; index += 1)
    dynamicBurst.push(await owner(`u${unique()}.freeddns.org`, network(`dyn-${unique()}`)));
  for (const one of dynamicBurst) {
    expect(await decision(one.accountId)).toMatchObject(HELD);
    expect(await lastHistory(one.accountId)).toMatchObject({ rule_id: "signup-burst-v1" });
  }
  await age(dynamicBurst, 7200);

  // One company domain on one network: a farm, held.
  const farmNetwork = network(`farm-${unique()}`);
  const farmDomain = `farm-${unique()}.dev`;
  const farmBurst: Owner[] = [];
  for (let index = 0; index < 4; index += 1) farmBurst.push(await owner(farmDomain, farmNetwork));
  for (const one of farmBurst) {
    expect(await decision(one.accountId)).toMatchObject(HELD);
    expect(await lastHistory(one.accountId)).toMatchObject({ rule_id: "signup-burst-v1" });
  }
  await age(farmBurst, 7200);
}, 180_000);

test("denied leg: two denied organizations on a company domain hold later owners; shared relays and single denials never do", async () => {
  if (!shared || !client) return;
  await configure(ONLY_DENIED);
  const domain = `throwaway-${unique()}.org`;
  const firstDenied = await owner(domain);
  await decide(firstDenied.accountId, "denied");
  await age([firstDenied], 3 * 86_400);
  const afterOne = await owner(domain);
  expect(await decision(afterOne.accountId)).toBeNull();
  await decide(afterOne.accountId, "denied");
  await age([afterOne], 2 * 86_400);
  const later = await owner(domain);
  expect(await decision(later.accountId)).toMatchObject(HELD);
  expect(await lastHistory(later.accountId)).toMatchObject({ rule_id: "email-denied-domain-v1" });

  // An academic domain is observed only.
  const school = `cs.uni-${unique()}.edu`;
  const schoolDenied = [await owner(school), await owner(school)];
  for (const one of schoolDenied) await decide(one.accountId, "denied");
  await age(schoolDenied, 3 * 86_400);
  const student = await owner(school);
  expect(await decision(student.accountId)).toBeNull();
  expect(await observation(student.accountId)).toMatchObject({
    ruleId: "email-denied-domain-v1",
    deniedDomainAccounts: 2,
  });

  // A shared relay never propagates a denial.
  const relayDenied = [await owner("mozmail.com"), await owner("mozmail.com")];
  for (const one of relayDenied) await decide(one.accountId, "denied");
  await age(relayDenied, 3 * 86_400);
  const relayLater = await owner("mozmail.com");
  expect(await decision(relayLater.accountId)).toBeNull();

  // A per-person dynamic DNS name is one person: one denial is enough, and
  // it never spreads to other names of the same host.
  const personalName = `p${unique()}.mywire.org`;
  const personalDenied = await owner(personalName);
  await decide(personalDenied.accountId, "denied");
  await age([personalDenied], 86_400);
  const personalLater = await owner(personalName);
  expect(await decision(personalLater.accountId)).toMatchObject(HELD);
  expect(await lastHistory(personalLater.accountId)).toMatchObject({
    rule_id: "email-denied-domain-v1",
  });
  const otherName = await owner(`q${unique()}.mywire.org`);
  expect(await decision(otherName.accountId)).toBeNull();
  await age([personalLater, otherName], 7200);

  // Held organizations do not propagate.
  const heldDomain = `quiet-${unique()}.org`;
  const held = [await owner(heldDomain), await owner(heldDomain)];
  for (const one of held) await decide(one.accountId, "held");
  await age(held, 3 * 86_400);
  const next = await owner(heldDomain);
  expect(await decision(next.accountId)).toBeNull();

  // Past the lookback the denials no longer count.
  await configure({ deniedDomainLookbackDays: 2 });
  const latest = await owner(domain);
  expect(await decision(latest.accountId)).toBeNull();
  await age(
    [
      firstDenied,
      afterOne,
      later,
      ...schoolDenied,
      student,
      ...relayDenied,
      relayLater,
      personalDenied,
      ...held,
      next,
      latest,
    ],
    7200,
  );
}, 180_000);

test("additional organizations: the second within a day of the first starts held, unless the person pays or the day has passed", async () => {
  if (!shared || !client) return;
  await configure({
    emailDomainMode: "off",
    burstMode: "off",
    deniedDomainMode: "off",
    disposableMailMode: "off",
    slowDomainMode: "off",
  });
  // Within a day of the first organization: the first additional one is
  // free, the second and later start held.
  const farm = await owner(`farm-${unique()}.net`);
  const farmExtra = [
    await additional(farm.userId),
    await additional(farm.userId),
    await additional(farm.userId),
  ];
  expect(await decision(farm.accountId)).toBeNull();
  expect(await decision(farmExtra[0]!.accountId)).toBeNull();
  expect(await decision(farmExtra[1]!.accountId)).toMatchObject(HELD);
  expect(await lastHistory(farmExtra[1]!.accountId)).toMatchObject({
    policy_version: "additional-organization-v1",
    rule_id: "additional-organization-burst-v1",
  });
  // Later ones are held by the same rule: a detector hold on an additional
  // organization holds only that organization, so the linked rule does not.
  expect(await decision(farmExtra[2]!.accountId)).toMatchObject(HELD);
  expect(await lastHistory(farmExtra[2]!.accountId)).toMatchObject({
    rule_id: "additional-organization-burst-v1",
  });
  const holds = await listSignupNetworkHolds(ownerClient!.db);
  const listed = holds.accounts.find((account) => account.accountId === farmExtra[1]!.accountId);
  expect(listed?.policyVersion).toBe("additional-organization-v1");
  expect(listed?.reason).toContain("additional organization");
  // The hold stays on the new organizations: the person's first organization
  // and first additional one keep their sandboxes.
  const [enforcement] = await shared!.admin`select enabled from promotion_enforcement
    where singleton`;
  await shared!.admin`insert into promotion_enforcement (singleton, enabled) values (true, true)
    on conflict (singleton) do update set enabled = true`;
  const standing = async (accountId: string) => {
    resetSandboxPersonStandingCache();
    return await resolveSandboxComputeStanding(client!.db, {
      accountId,
      limits: DEFAULT_SANDBOX_PLAN_LIMITS,
      actingSubjectId: `user:${farm.userId}`,
    });
  };
  for (const accountId of [farm.accountId, farmExtra[0]!.accountId]) {
    expect(await standing(accountId)).toMatchObject({ linkedRestricted: false });
    expect((await standing(accountId)).tier).not.toBe("restricted");
  }
  expect((await standing(farmExtra[1]!.accountId)).tier).toBe("restricted");
  // A reviewer's denial still follows the person, into their organizations
  // and their next new one.
  await decide(farmExtra[1]!.accountId, "denied");
  expect(await standing(farm.accountId)).toMatchObject({
    linkedRestricted: true,
    tier: "restricted",
  });
  await shared!.admin`update managed_accounts set created_at = created_at - interval '25 hours'
    where id = ${farm.accountId}`;
  const afterDenial = await additional(farm.userId);
  expect(await decision(afterDenial.accountId)).toMatchObject(HELD);
  expect(await lastHistory(afterDenial.accountId)).toMatchObject({
    policy_version: "linked-owner-v1",
  });
  await shared!.admin`update promotion_enforcement set enabled = ${enforcement?.enabled ?? false}
    where singleton`;

  // A person whose organization pays is never held.
  const paying = await owner(`paying-${unique()}.net`);
  await shared!.admin`insert into organization_plans (account_id, plan_key, status)
    values (${paying.accountId}, 'pro', 'active')
    on conflict (account_id) do update set plan_key = excluded.plan_key, status = excluded.status`;
  for (let index = 0; index < 3; index += 1) {
    const extra = await additional(paying.userId);
    expect(await decision(extra.accountId)).toBeNull();
  }

  // A day after the first organization, additional ones are not held.
  const settled = await owner(`settled-${unique()}.net`);
  await shared!.admin`update managed_accounts set created_at = created_at - interval '25 hours'
    where id = ${settled.accountId}`;
  for (let index = 0; index < 3; index += 1) {
    const extra = await additional(settled.userId);
    expect(await decision(extra.accountId)).toBeNull();
  }
  await configure(DEFAULTS);
}, 180_000);

test("manual decisions win, and every leg off lists and evaluates nothing", async () => {
  if (!shared || !client) return;
  await configure({ ...DEFAULTS, ...ONLY_DOMAIN });
  const domain = `manual-${unique()}.ai`;
  const first = await owner(domain);
  await decide(first.accountId, "eligible");
  const rest = [await owner(domain), await owner(domain)];
  expect(await decision(first.accountId)).toMatchObject({
    decision: "eligible",
    actor: "operator:test",
  });
  for (const one of rest) expect(await decision(one.accountId)).toMatchObject(HELD);

  await configure({
    emailDomainMode: "off",
    burstMode: "off",
    deniedDomainMode: "off",
    disposableMailMode: "off",
    slowDomainMode: "off",
  });
  const quiet = `off-${unique()}.ai`;
  const off = [await owner(quiet), await owner(quiet), await owner(quiet), await owner(quiet)];
  for (const one of off) {
    expect(one.evaluateAccountIds).toEqual([]);
    expect(await decision(one.accountId)).toBeNull();
  }
  await configure(DEFAULTS);
}, 180_000);

// Migration 1493: disposable mail and slow domain legs.
async function mailRecord(accountId: string) {
  const [row] = await shared!.admin`select mail_signal, first_admitted_at
    from opengeni_private.signup_owner_email_domains
    where data_schema = ${shared!.schema} and account_id = ${accountId}`;
  return row ?? null;
}

test("disposable leg: a disposable inbox holds a first or additional organization; clear or unknown never do", async () => {
  if (!shared || !client) return;
  await configure(ONLY_DISPOSABLE);
  const throwaway = await owner(`inbox-${unique()}.net`, null, "disposable");
  expect(await decision(throwaway.accountId)).toMatchObject(HELD);
  expect(await lastHistory(throwaway.accountId)).toMatchObject({
    rule_id: "disposable-mail-v1",
    evidence: { mailSignal: "disposable", disposableMailMode: "enforce" },
  });
  expect(await mailRecord(throwaway.accountId)).toMatchObject({ mail_signal: "disposable" });

  const clear = await owner(`company-${unique()}.com`, null, "clear");
  expect(await decision(clear.accountId)).toBeNull();
  expect(await mailRecord(clear.accountId)).toMatchObject({ mail_signal: "clear" });
  const unknown = await owner(`company-${unique()}.com`);
  expect(await decision(unknown.accountId)).toBeNull();
  expect(await mailRecord(unknown.accountId)).toMatchObject({ mail_signal: null });

  // An additional organization is checked the same way.
  const extra = await additional(clear.userId, "disposable");
  expect(await decision(extra.accountId)).toMatchObject(HELD);

  // Observed only: recorded, never held.
  await configure({ disposableMailMode: "observe" });
  const observed = await owner(`inbox-${unique()}.net`, null, "disposable");
  expect(await decision(observed.accountId)).toBeNull();
  expect(await observation(observed.accountId)).toMatchObject({ ruleId: "disposable-mail-v1" });
  await age([throwaway, clear, unknown, extra, observed], 86_400 * 2);
  await configure(DEFAULTS);
}, 180_000);

test("slow domain leg: three unused owners of one company domain within a day are held; a used group, public domains and a later day are not", async () => {
  if (!shared || !client) return;
  await configure(ONLY_SLOW);
  // A farm: one owner every few hours, none ever used.
  const farmDomain = `slow-${unique()}.com`;
  const farm: Owner[] = [];
  for (let index = 0; index < 3; index += 1) {
    if (farm.length > 0) await age(farm, 3 * 3600);
    farm.push(await owner(farmDomain));
  }
  for (const one of farm) expect(await decision(one.accountId)).toMatchObject(HELD);
  expect(await lastHistory(farm[2]!.accountId)).toMatchObject({
    rule_id: "email-slow-domain-v1",
    evidence: { slowDomainGroupSize: 3, slowDomainGroupUsed: false },
  });

  // A company: the first colleague starts working before the third signs up.
  const teamDomain = `team-${unique()}.com`;
  const first = await owner(teamDomain);
  await getSpendableCreditBalance(client.db, first.accountId);
  expect((await mailRecord(first.accountId))?.first_admitted_at).not.toBeNull();
  await age([first], 3600);
  const team = [first, await owner(teamDomain), await owner(teamDomain)];
  for (const one of team) expect(await decision(one.accountId)).toBeNull();
  expect(await observation(team[2]!.accountId)).toMatchObject({
    slowDomainGroupSize: 3,
    slowDomainGroupUsed: true,
  });

  // Owners more than a day apart, and public providers, never group.
  const spreadDomain = `spread-${unique()}.com`;
  const spread: Owner[] = [];
  for (let index = 0; index < 3; index += 1) {
    if (spread.length > 0) await age(spread, 25 * 3600);
    spread.push(await owner(spreadDomain));
  }
  for (const one of spread) expect(await decision(one.accountId)).toBeNull();
  const publicOwners = [
    await owner("gmail.com"),
    await owner("gmail.com"),
    await owner("gmail.com"),
  ];
  for (const one of publicOwners) expect(await decision(one.accountId)).toBeNull();
  await age([...farm, ...team, ...spread, ...publicOwners], 86_400 * 2);
  await configure(DEFAULTS);
}, 180_000);

test("slow domain leg: once a held colleague sends a model call, the group's slow holds release; other holds stay", async () => {
  if (!shared || !client) return;
  await configure(ONLY_SLOW);
  // Real colleagues who signed up over a day before anyone used the product.
  const domain = `colleagues-${unique()}.com`;
  const team: Owner[] = [];
  for (let index = 0; index < 5; index += 1) {
    if (team.length > 0) await age(team, 2 * 3600);
    team.push(await owner(domain));
  }
  for (const one of team) expect(await decision(one.accountId)).toMatchObject(HELD);
  const [caller, second, third, operatorHeld, otherRuleHeld] = team as [
    Owner,
    Owner,
    Owner,
    Owner,
    Owner,
  ];
  // A manual operator hold, and a detector hold from another rule, are never lifted here.
  await decide(operatorHeld.accountId, "held");
  const otherRevision = (await decision(otherRuleHeld.accountId))!.revision;
  await shared.admin`select opengeni_private.set_promotion_decision(${otherRuleHeld.accountId}::uuid,
    'held', 'ip-velocity-v1', 'ip-velocity-v1', '{"reason":"test"}'::jsonb,
    'service:promotion-detector', ${otherRevision}::bigint)`;

  // The first model call's admission stamps the use and releases the
  // caller's own hold in the same evaluation, before the eligibility check,
  // so that very call proceeds.
  await getSpendableCreditBalance(client.db, caller.accountId);
  expect((await mailRecord(caller.accountId))?.first_admitted_at).not.toBeNull();
  expect(await decision(caller.accountId)).toMatchObject({
    decision: "eligible",
    actor: "service:promotion-detector",
  });
  expect(await lastHistory(caller.accountId)).toMatchObject({
    policy_version: "email-cluster-v1",
    rule_id: "email-slow-domain-released-v1",
    evidence: { slowDomainGroupUsed: true },
  });
  // Each colleague's organization releases on its own next evaluation (its
  // first admission or any check), without using the product itself.
  await evaluate([
    second.accountId,
    third.accountId,
    operatorHeld.accountId,
    otherRuleHeld.accountId,
  ]);
  for (const one of [second, third]) {
    expect(await decision(one.accountId)).toMatchObject({ decision: "eligible" });
    expect((await mailRecord(one.accountId))?.first_admitted_at).toBeNull();
  }
  expect(await decision(operatorHeld.accountId)).toMatchObject({
    decision: "held",
    actor: "operator:test",
  });
  expect(await decision(otherRuleHeld.accountId)).toMatchObject(HELD);
  expect(await lastHistory(otherRuleHeld.accountId)).toMatchObject({ rule_id: "ip-velocity-v1" });
  // Released organizations are not held again by the used group.
  await evaluate([caller.accountId, second.accountId]);
  expect(await decision(second.accountId)).toMatchObject({ decision: "eligible" });
  await age(team, 86_400 * 2);
  await configure(DEFAULTS);
}, 180_000);

test("with the shipped defaults, two denied organizations on a custom domain hold the next signup there", async () => {
  if (!shared || !client) return;
  await configure(DEFAULTS);
  const domain = `custom-${unique()}.io`;
  const firstDenied = await owner(domain);
  await decide(firstDenied.accountId, "denied");
  await age([firstDenied], 2 * 86_400);
  const secondDenied = await owner(domain);
  await decide(secondDenied.accountId, "denied");
  await age([secondDenied], 2 * 86_400);
  const next = await owner(domain);
  expect(await decision(next.accountId)).toMatchObject(HELD);
  expect(await lastHistory(next.accountId)).toMatchObject({ rule_id: "email-denied-domain-v1" });
}, 180_000);
