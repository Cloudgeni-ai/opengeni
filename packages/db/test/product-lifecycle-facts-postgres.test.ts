import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import {
  CREDIT_GRANT_CLASSES,
  PRODUCT_LIFECYCLE_FACT_ATTRIBUTES,
  PRODUCT_LIFECYCLE_FACT_TYPES,
  type HostLifecycleFactExportBatch,
} from "@opengeni/contracts";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";

import {
  acceptOrganizationInvitation,
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  claimHostExportBatch,
  countActiveUsers,
  completeSelfServiceOrganizationSetup,
  createAdditionalManagedOrganization,
  createConnection,
  createDb,
  createEnrollment,
  createOrganizationInvitation,
  createScheduledTask,
  createXaiSubscriptionCredential,
  deadLetterHostExportHead,
  disableHostExportConsumer,
  installPortableSkill,
  readCreditGrantTotals,
  recordUserActivityPresence,
  registerHostExportConsumer,
  revokeConnection,
  saveSlackBotUserLink,
  upsertCodexSubscriptionCredential,
  upsertOrganizationModelProviderConnection,
  type DbClient,
} from "../src";
import {
  ensureCanonicalHumanIdentityForAuthUser,
  getCanonicalHumanExactLoginBindingForAuthUser,
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "../src/canonical-human-identities";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

// Replaying the full migration ledger is slow and grows with every migration.
setDefaultTimeout(180_000);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const CONSUMER = "lifecycle-facts-test";
const migrationText = readFileSync(
  new URL("../drizzle/0532_product_lifecycle_fact_export.sql", import.meta.url),
  "utf8",
);
const usageAnalyticsMigrationText = readFileSync(
  new URL("../drizzle/0565_usage_analytics_presence_and_facts.sql", import.meta.url),
  "utf8",
);

let owned: OwnerMigratedTestDatabase | null = null;
// The opengeni_app runtime role: FORCE RLS applies, exactly like production.
let client: DbClient | null = null;
// The migration owner stands in for the separately provisioned exporter role.
let exporter: DbClient | null = null;

type FactRow = {
  source_id: string;
  event_type: string;
  account_id: string | null;
  workspace_id: string | null;
  session_id: string | null;
  initiator: { kind: string; subjectId: string } | null;
  initiator_context: Record<string, unknown>;
  origin: string | null;
  payload: { factType: string; attribute: string | null; subjectKind: string };
};

/** Every value a test wrote that must never reach the export. */
const personalValues: string[] = [];
function remember<T extends string>(value: T): T {
  personalValues.push(value);
  return value;
}

async function lifecycleRows(): Promise<FactRow[]> {
  return await owned!.admin<FactRow[]>`
    select source_id::text, event_type, account_id::text, workspace_id::text,
      session_id::text, initiator, initiator_context, origin, payload
    from host_export_outbox
    where export_kind = 'lifecycle_fact'
    order by enqueued_at, id`;
}

async function factsFor(filter: {
  type: string;
  subjectId?: string;
  accountId?: string;
}): Promise<FactRow[]> {
  return (await lifecycleRows()).filter(
    (row) =>
      row.event_type === filter.type &&
      (filter.subjectId === undefined || row.initiator?.subjectId === filter.subjectId) &&
      (filter.accountId === undefined || row.account_id === filter.accountId),
  );
}

async function insertAuthUser(input: {
  verified: boolean;
  provider?: "credential" | "google";
}): Promise<{ userId: string; subjectId: string; email: string }> {
  const userId = crypto.randomUUID();
  const email = remember(`lifecycle-${userId}@example.test`);
  const name = remember(`Lifecycle Person ${userId.slice(0, 8)}`);
  await owned!.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${name}, ${email}, ${input.verified})`;
  if (input.provider) {
    await owned!.admin`
      insert into auth_identities (id, user_id, account_id, provider_id, created_at, updated_at)
      values (${crypto.randomUUID()}, ${userId},
        ${input.provider === "credential" ? userId : `google-${userId}`},
        ${input.provider}, now(), now())`;
  }
  return { userId, subjectId: `user:${userId}`, email };
}

async function workspace(label: string, subjectId: string) {
  const key = crypto.randomUUID();
  const grant = (
    await bootstrapWorkspace(client!.db, {
      accountExternalSource: "lifecycle-test",
      accountExternalId: key,
      accountName: remember(`Lifecycle org ${label} ${key.slice(0, 8)}`),
      workspaceExternalSource: "lifecycle-test",
      workspaceExternalId: key,
      workspaceName: remember(`Lifecycle workspace ${label} ${key.slice(0, 8)}`),
      subjectId,
    })
  ).workspaceGrants[0]!;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId! };
}

async function verifiedOwner(organizationName: string) {
  const person = await insertAuthUser({ verified: true, provider: "credential" });
  const setup = await completeSelfServiceOrganizationSetup(client!.db, {
    authUserId: person.userId,
    actorSubjectId: person.subjectId,
    organizationName: remember(organizationName),
    operationId: crypto.randomUUID(),
    requestFingerprint: "c".repeat(64),
  });
  return { ...person, organizationId: setup.organizationId };
}

async function stampedSession(userId: string, expiresAt: Date): Promise<string> {
  await ensureCanonicalHumanIdentityForAuthUser(client!.db, userId);
  await synchronizeCanonicalHumanLoginBindings(client!.db, userId);
  const projection = await getCanonicalHumanIdentityProjection(client!.db, userId);
  const binding = await getCanonicalHumanExactLoginBindingForAuthUser(client!.db, {
    authUserId: userId,
    providerId: "credential",
  });
  const sessionId = crypto.randomUUID();
  await owned!.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at, ip_address, user_agent,
      identity_id, identity_revision, auth_revision,
      login_binding_id, login_binding_revision
    ) values (
      ${sessionId}, ${userId}, ${remember(`session-token-${crypto.randomUUID()}`)}, ${expiresAt},
      ${remember("203.0.113.77")}, ${remember("LifecycleTestBrowser/1.0")},
      ${projection.activeIdentity.id}, ${projection.activeIdentity.identityRevision},
      ${projection.activeIdentity.authRevision}, ${binding.id}, ${binding.revision}
    )`;
  return sessionId;
}

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("product-lifecycle-facts");
  if (!owned) {
    if (requireRealDatabase) throw new Error("lifecycle fact PostgreSQL fixture is unavailable");
    return;
  }
  // Migrate as the NOSUPERUSER NOBYPASSRLS owner so the capture triggers run
  // under FORCE RLS exactly as they do in production.
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
  exporter = createDb(owned.ownerUrl, { max: 2 });
}, 900_000);

afterAll(async () => {
  await Promise.allSettled([client?.close(), exporter?.close()]);
  await owned?.release();
}, 180_000);

describe("product lifecycle facts (real PostgreSQL)", () => {
  test("the migration is rolling and its fixed lists match the contract", async () => {
    expect(migrationText.split("\n", 1)[0]).toBe("-- deployment-mode: rolling");
    expect(usageAnalyticsMigrationText.split("\n", 1)[0]).toBe("-- deployment-mode: rolling");
    if (!owned) return;
    for (const type of PRODUCT_LIFECYCLE_FACT_TYPES) {
      const allowed: readonly string[] = PRODUCT_LIFECYCLE_FACT_ATTRIBUTES[type];
      for (const attribute of allowed.length === 0 ? [null] : allowed) {
        const [row] = await owned.admin<{ valid: boolean }[]>`
          select opengeni_private.product_lifecycle_fact_valid(${type}, ${attribute}) as valid`;
        expect({ type, attribute, valid: row?.valid }).toEqual({ type, attribute, valid: true });
      }
      const [invalid] = await owned.admin<{ valid: boolean }[]>`
        select opengeni_private.product_lifecycle_fact_valid(
          ${type}, ${allowed.length === 0 ? "email" : null}) as valid`;
      expect(invalid?.valid).toBe(false);
    }
    const [unknown] = await owned.admin<{ valid: boolean }[]>`
      select opengeni_private.product_lifecycle_fact_valid('login.anything', null) as valid`;
    expect(unknown?.valid).toBe(false);

    // Every database value is a known contract value: nothing outside the lists.
    const classes = await owned.admin<{ domain: string; class: string }[]>`
      select domain, opengeni_private.product_lifecycle_connection_class(domain) as class
      from unnest(${[
        "slack.com",
        "mcp.slack.com",
        "github.com",
        "gmailmcp.googleapis.com",
        "linear.app",
        "api.atlassian.com",
        "chatgpt.com",
        "mcp.customer-internal.example",
        "",
      ]}::text[]) as domain`;
    expect(Object.fromEntries(classes.map((row) => [row.domain, row.class]))).toEqual({
      "slack.com": "slack",
      "mcp.slack.com": "slack",
      "github.com": "github",
      "gmailmcp.googleapis.com": "google",
      "linear.app": "linear",
      "api.atlassian.com": "atlassian",
      "chatgpt.com": "openai",
      "mcp.customer-internal.example": "other",
      "": "other",
    });
    for (const row of classes) {
      expect(PRODUCT_LIFECYCLE_FACT_ATTRIBUTES["connection.created"]).toContain(row.class as never);
    }
    const grantClasses = await owned.admin<
      { type: string; source: string | null; class: string }[]
    >`
      select type, source, opengeni_private.credit_grant_class(type, source) as class
      from (values
        ('grant', 'verified_signup_trial'),
        ('grant', 'stripe_checkout_coupon'),
        ('manual_credit_grant', 'stripe_checkout_session'),
        ('grant', 'operator_adjustment'),
        ('grant', 'promotion'),
        ('grant', null)
      ) as input(type, source)`;
    expect(grantClasses.map((row) => row.class)).toEqual([
      "signup_trial",
      "coupon",
      "manual",
      "manual",
      "other",
      "other",
    ]);
    for (const row of grantClasses) {
      expect(CREDIT_GRANT_CLASSES).toContain(row.class as never);
    }
    const methods = await owned.admin<{ provider: string; method: string }[]>`
      select provider, opengeni_private.product_lifecycle_auth_method(provider) as method
      from unnest(${["credential", "google", "github", "test-oidc"]}::text[]) as provider`;
    expect(Object.fromEntries(methods.map((row) => [row.provider, row.method]))).toEqual({
      credential: "email",
      google: "google",
      github: "github",
      "test-oidc": "other",
    });
  });

  test("captures nothing until a lifecycle consumer registers", async () => {
    if (!owned || !exporter) return;
    await insertAuthUser({ verified: true, provider: "credential" });
    await verifiedOwner("Before registration org");
    expect(await lifecycleRows()).toEqual([]);

    await registerHostExportConsumer(exporter.db, { kind: "lifecycle_fact", consumerId: CONSUMER });
    // Only the lifecycle gate opened; session and usage capture stay off.
    const [config] = await owned.admin<
      { session_events_enabled: boolean; usage_events_enabled: boolean; lifecycle: boolean }[]
    >`select session_events_enabled, usage_events_enabled,
        lifecycle_facts_enabled as lifecycle from host_export_config where id = 1`;
    expect(config).toEqual({
      session_events_enabled: false,
      usage_events_enabled: false,
      lifecycle: true,
    });
  });

  test("sign-up, verification and sign-in each write exactly one fact", async () => {
    if (!owned || !client) return;
    // Email sign-up: the first identity decides the method.
    const email = await insertAuthUser({ verified: false, provider: "credential" });
    expect(await factsFor({ type: "auth.sign_up", subjectId: email.subjectId })).toHaveLength(1);
    expect(await factsFor({ type: "auth.email_verified", subjectId: email.subjectId })).toEqual([]);
    // Linking a second sign-in method later is not another sign-up.
    await owned.admin`
      insert into auth_identities (id, user_id, account_id, provider_id, created_at, updated_at)
      values (${crypto.randomUUID()}, ${email.userId}, ${`github-${email.userId}`}, 'github', now(), now())`;
    const signUps = await factsFor({ type: "auth.sign_up", subjectId: email.subjectId });
    expect(signUps.map((row) => [row.payload.attribute, row.account_id])).toEqual([
      ["email", null],
    ]);

    await owned.admin`update auth_users set email_verified = true where id = ${email.userId}`;
    await owned.admin`update auth_users set name = ${remember("Renamed Person")}, email_verified = true
      where id = ${email.userId}`;
    expect(
      await factsFor({ type: "auth.email_verified", subjectId: email.subjectId }),
    ).toHaveLength(1);

    // A social sign-up arrives already verified.
    const social = await insertAuthUser({ verified: true, provider: "google" });
    expect(
      (await factsFor({ type: "auth.sign_up", subjectId: social.subjectId })).map(
        (row) => row.payload.attribute,
      ),
    ).toEqual(["google"]);
    expect(
      await factsFor({ type: "auth.email_verified", subjectId: social.subjectId }),
    ).toHaveLength(1);

    // A live session is a sign-in; a session-set discarded session is not.
    // With two linked methods the method comes from the session's exact login
    // binding, which the trigger reads under FORCE RLS as the non-superuser owner.
    const password = await insertAuthUser({ verified: true, provider: "credential" });
    await owned.admin`
      insert into auth_identities (id, user_id, account_id, provider_id, created_at, updated_at)
      values (${crypto.randomUUID()}, ${password.userId}, ${`github-${password.userId}`},
        'github', now(), now())`;
    await stampedSession(password.userId, new Date(Date.now() + 3_600_000));
    await stampedSession(password.userId, new Date(0));
    const signIns = await factsFor({ type: "auth.sign_in", subjectId: password.subjectId });
    expect(signIns.map((row) => [row.payload.attribute, row.account_id])).toEqual([
      ["email", null],
    ]);
    await stampedSession(password.userId, new Date(Date.now() + 3_600_000));
    expect(await factsFor({ type: "auth.sign_in", subjectId: password.subjectId })).toHaveLength(2);
  });

  test("organization setup and joining write one fact per organization and member", async () => {
    if (!owned || !client) return;
    const owner = await verifiedOwner("Lifecycle owner org");
    const created = await factsFor({ type: "organization.setup", accountId: owner.organizationId });
    expect(created.map((row) => [row.payload.attribute, row.initiator?.subjectId])).toEqual([
      ["created", owner.subjectId],
    ]);
    // The founder's own membership is not a join.
    expect(await factsFor({ type: "member.joined", accountId: owner.organizationId })).toEqual([]);

    const additional = await createAdditionalManagedOrganization(client.db, {
      subjectId: owner.subjectId,
      subjectLabel: remember("Owner Label"),
      name: remember("Lifecycle additional org"),
      workspaceName: remember("Lifecycle additional workspace"),
      operationId: crypto.randomUUID(),
    });
    expect(
      (await factsFor({ type: "organization.setup", accountId: additional.organization.id })).map(
        (row) => row.payload.attribute,
      ),
    ).toEqual(["additional"]);

    await owned.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${owner.organizationId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'lifecycle-test')
      on conflict (account_id) do nothing`;
    const invitee = await insertAuthUser({ verified: true, provider: "credential" });
    const invitation = await createOrganizationInvitation(client.db, {
      organizationId: owner.organizationId,
      actorSubjectId: owner.subjectId,
      operationId: crypto.randomUUID(),
      targetSubjectId: invitee.subjectId,
      targetEmail: invitee.email,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await acceptOrganizationInvitation(client.db, {
      organizationId: owner.organizationId,
      actorSubjectId: invitee.subjectId,
      operationId: crypto.randomUUID(),
      invitationId: invitation.id,
      expectedRevision: invitation.revision,
    });
    const joined = await factsFor({ type: "member.joined", accountId: owner.organizationId });
    expect(joined.map((row) => row.initiator?.subjectId)).toEqual([invitee.subjectId]);
  });

  test("model, credit, connection, schedule, Skill, Slack and machine setup each write one fact", async () => {
    if (!owned || !client) return;
    const owner = await verifiedOwner("Lifecycle setup org");
    const person = `user:setup-${crypto.randomUUID()}`;
    const target = await workspace("setup", person);

    const codex = await upsertCodexSubscriptionCredential(client.db, {
      ...target,
      credentialEncrypted: remember(`codex-ciphertext-${crypto.randomUUID()}`),
      chatgptAccountId: remember(`chatgpt-${crypto.randomUUID()}`),
      scopes: null,
      planType: "pro",
      isFedramp: false,
      expiresAt: new Date(Date.now() + 60_000),
      lastRefreshAt: new Date(),
      accountEmail: remember(`codex-${crypto.randomUUID()}@example.test`),
      connectedBySubjectId: person,
    });
    expect(codex).toBeDefined();
    await createXaiSubscriptionCredential(client.db, {
      ...target,
      subjectId: person,
      encryptionKey: Buffer.alloc(32, 7),
      secret: { version: 1, accessToken: remember(`xai-secret-${crypto.randomUUID()}`) },
      providerAccountId: remember(`xai-account-${crypto.randomUUID()}`),
      label: remember("Lifecycle xAI label"),
    });
    await upsertOrganizationModelProviderConnection(client.db, {
      organizationId: owner.organizationId,
      actorSubjectId: owner.subjectId,
      providerKind: "openrouter",
      credentialEncrypted: remember(`openrouter-ciphertext-${crypto.randomUUID()}`),
      credentialDigest: "credential-digest",
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
    });
    for (const providerKind of ["anthropic", "claude_subscription"] as const) {
      await upsertOrganizationModelProviderConnection(client.db, {
        organizationId: owner.organizationId,
        actorSubjectId: owner.subjectId,
        providerKind,
        credentialEncrypted: "encrypted-test",
        credentialDigest: "test-digest",
        operationId: crypto.randomUUID(),
        expectedVersion: 0,
      });
    }
    const models = [
      ...(await factsFor({ type: "model.connected", accountId: target.accountId })),
      ...(await factsFor({ type: "model.connected", accountId: owner.organizationId })),
    ];
    expect(models.map((row) => row.payload.attribute).sort()).toEqual([
      "anthropic",
      "claude_subscription",
      "codex",
      "openrouter",
      "supergrok",
    ]);
    expect(models.find((row) => row.payload.attribute === "codex")?.initiator?.subjectId).toBe(
      person,
    );

    const topUp = {
      accountId: owner.organizationId,
      type: "credit_topup",
      amountMicros: 25_000_000,
      sourceType: "stripe_checkout_session",
      sourceId: remember(`cs_test_${crypto.randomUUID()}`),
      idempotencyKey: `lifecycle-topup:${crypto.randomUUID()}`,
    };
    await applyCreditLedgerEntry(client.db, topUp);
    await applyCreditLedgerEntry(client.db, topUp);
    await applyCreditLedgerEntry(client.db, {
      ...topUp,
      type: "manual_credit_grant",
      idempotencyKey: `lifecycle-grant:${crypto.randomUUID()}`,
    });
    const credits = await factsFor({ type: "credits.purchased", accountId: owner.organizationId });
    expect(credits.map((row) => [row.payload.subjectKind, row.initiator])).toEqual([
      ["none", null],
    ]);

    const privateDomain = remember(`mcp.${crypto.randomUUID()}.customer-internal.example`);
    const slack = await createConnection(client.db, {
      ...target,
      subjectId: null,
      providerDomain: "slack.com",
      kind: "app_install",
      credentialEncrypted: remember(`slack-ciphertext-${crypto.randomUUID()}`),
      grantedScopes: [],
      metadata: { team: remember(`T${crypto.randomUUID().slice(0, 8)}`) },
      createdBySubjectId: person,
    });
    await createConnection(client.db, {
      ...target,
      subjectId: null,
      providerDomain: privateDomain,
      kind: "api_key",
      credentialEncrypted: remember(`custom-ciphertext-${crypto.randomUUID()}`),
      grantedScopes: [],
      metadata: {},
      createdBySubjectId: person,
    });
    const connections = await factsFor({ type: "connection.created", accountId: target.accountId });
    expect(connections.map((row) => row.payload.attribute).sort()).toEqual(["other", "slack"]);
    expect(connections.every((row) => row.workspace_id === target.workspaceId)).toBe(true);

    await createScheduledTask(client.db, {
      ...target,
      name: remember(`Lifecycle morning report ${crypto.randomUUID().slice(0, 6)}`),
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `lifecycle-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: remember("Summarize the private customer pipeline"),
        resources: [],
        tools: [],
        metadata: {},
      },
      createdBy: { kind: "subject", subjectId: person },
      metadata: {},
    });
    expect(
      (await factsFor({ type: "scheduled_task.created", accountId: target.accountId })).map(
        (row) => row.initiator?.subjectId,
      ),
    ).toEqual([person]);

    // A machine principal installs a catalog Skill: its subject is reduced to
    // its kind because non-user subjects may carry host identifiers.
    const skillKey = crypto.randomUUID();
    const content = `---\nname: test-skill\ndescription: Lifecycle Skill\n---\n${remember("Private Skill body")}`;
    const digest = createHash("sha256").update(content).digest("hex");
    const machineActor = {
      kind: "service",
      subjectId: `service:lifecycle-${skillKey}`,
      principalKind: "service",
    } as const;
    await installPortableSkill(client.db, {
      ...target,
      subjectId: machineActor.subjectId,
      skillActor: machineActor,
      skillOperationId: crypto.randomUUID(),
      capabilityId: `skill:${skillKey}`,
      pluginKey: `skill/lifecycle/${skillKey}`,
      source: "github",
      sourceUrl: "https://example.test/lifecycle",
      repositoryUrl: "https://example.test/lifecycle",
      sourceCommit: "a".repeat(40),
      sourcePath: skillKey,
      name: "test-skill",
      description: "Lifecycle Skill",
      contentSha256: digest,
      totalBytes: Buffer.byteLength(content),
      files: [
        {
          path: "SKILL.md",
          content,
          byteSize: Buffer.byteLength(content),
          contentSha256: digest,
        },
      ],
    });
    const skills = await factsFor({ type: "skill.installed", accountId: target.accountId });
    expect(skills.map((row) => [row.payload.subjectKind, row.initiator])).toEqual([
      ["service", null],
    ]);

    const slackUser = remember(`U${crypto.randomUUID().slice(0, 10)}`);
    const link = {
      ...target,
      connectionId: slack.id,
      slackTeamId: remember(`T${crypto.randomUUID().slice(0, 10)}`),
      slackUserId: slackUser,
      subjectId: person,
      linkedBySubjectId: person,
    };
    await saveSlackBotUserLink(client.db, link);
    await saveSlackBotUserLink(client.db, link);
    expect(
      (await factsFor({ type: "slack.user_linked", accountId: target.accountId })).map(
        (row) => row.initiator?.subjectId,
      ),
    ).toEqual([person]);

    const pubkey = remember(`ed25519:${crypto.randomUUID()}`);
    await createEnrollment(client.db, { ...target, pubkey });
    await createEnrollment(client.db, { ...target, pubkey });
    expect(await factsFor({ type: "machine.enrolled", accountId: target.accountId })).toHaveLength(
      1,
    );
  });

  test("presence, credit grants and connection revocations write bounded facts", async () => {
    if (!owned || !client) return;
    type AdminSql = OwnerMigratedTestDatabase["admin"];
    const withoutTriggers = async (statement: (tx: AdminSql) => Promise<unknown>) =>
      await owned!.admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await statement(tx as unknown as AdminSql);
      });

    // Presence: only opaque user subjects are stored; API keys, services,
    // configured and local subjects are dropped before the database.
    const active = await insertAuthUser({ verified: true, provider: "credential" });
    expect(
      await recordUserActivityPresence(client.db, [
        active.subjectId,
        active.subjectId,
        "api_key:abcdefgh1234",
        "service:scheduler",
        "dev",
        "configured:host-user@example.test",
      ]),
    ).toBe(1);
    // A repeat inside the 30 second window writes nothing and no second fact.
    expect(await recordUserActivityPresence(client.db, [active.subjectId])).toBe(0);
    const first = await factsFor({ type: "user.active", subjectId: active.subjectId });
    expect(
      first.map((row) => [row.payload.attribute, row.payload.subjectKind, row.account_id]),
    ).toEqual([[null, "user", null]]);
    const stored = await owned.admin<{ subject_id: string }[]>`
      select subject_id from opengeni_private.user_activity_presence order by subject_id`;
    expect(stored.map((row) => row.subject_id)).toEqual([active.subjectId]);

    // A person last seen on an earlier UTC day becomes active again today.
    const returning = await insertAuthUser({ verified: true, provider: "credential" });
    await withoutTriggers(
      (tx) => tx`
        insert into opengeni_private.user_activity_presence
          (subject_id, first_seen_at, last_seen_at, active_day)
        values (${returning.subjectId}, now() - interval '3 days', now() - interval '2 days',
          ((now() - interval '2 days') at time zone 'UTC')::date)`,
    );
    expect(await factsFor({ type: "user.active", subjectId: returning.subjectId })).toEqual([]);
    expect(await recordUserActivityPresence(client.db, [returning.subjectId])).toBe(1);
    expect(await factsFor({ type: "user.active", subjectId: returning.subjectId })).toHaveLength(1);
    const [returned] = await owned.admin<{ first: Date; last: Date }[]>`
      select first_seen_at as first, last_seen_at as last
      from opengeni_private.user_activity_presence where subject_id = ${returning.subjectId}`;
    expect(Date.now() - returned!.last.getTime()).toBeLessThan(60_000);
    expect(Date.now() - returned!.first.getTime()).toBeGreaterThan(2 * 86_400_000);

    // Windowed counts: two people now, one 2h ago, one 10d ago, one 40d ago.
    for (const [label, age] of [
      ["two-hours", "2 hours"],
      ["ten-days", "10 days"],
      ["forty-days", "40 days"],
    ] as const) {
      await withoutTriggers(
        (tx) => tx`
          insert into opengeni_private.user_activity_presence
            (subject_id, first_seen_at, last_seen_at, active_day)
          values (${`user:presence-${label}`}, now() - ${age}::interval,
            now() - ${age}::interval, ((now() - ${age}::interval) at time zone 'UTC')::date)`,
      );
    }
    expect(await countActiveUsers(client.db)).toEqual({
      "5m": 2,
      "15m": 2,
      "1h": 2,
      "24h": 3,
      "7d": 3,
      "30d": 4,
    });
    // The runtime role reaches presence only through its two capabilities.
    let directRead: unknown = null;
    try {
      await client.db.execute(sql`select * from opengeni_private.user_activity_presence`);
    } catch (error) {
      directRead = error;
    }
    expect(directRead).not.toBeNull();

    // Credit grants: every writer is observed and exported with its class.
    const owner = await verifiedOwner("Lifecycle grant org");
    const before = await readCreditGrantTotals(client.db);
    const grant = (type: string, sourceType: string, amountMicros: number) =>
      applyCreditLedgerEntry(client!.db, {
        accountId: owner.organizationId,
        type,
        amountMicros,
        sourceType,
        sourceId: remember(`grant-source-${crypto.randomUUID()}`),
        idempotencyKey: `lifecycle-grant:${crypto.randomUUID()}`,
      });
    await grant("grant", "stripe_checkout_coupon", 5_000_000);
    await grant("manual_credit_grant", "operator_adjustment", 7_000_000);
    await grant("grant", "promotion", 3_000_000);
    // A negative or non-grant row is neither a grant fact nor an observation.
    await grant("grant", "promotion", -1_000_000);
    await grant("credit_refund", "stripe_refund", -2_000_000);
    const granted = await factsFor({ type: "credits.granted", accountId: owner.organizationId });
    expect(granted.map((row) => row.payload.attribute).sort()).toEqual([
      "coupon",
      "manual",
      "other",
    ]);
    const after = await readCreditGrantTotals(client.db);
    expect({
      coupon: after.coupon.count - before.coupon.count,
      manual: after.manual.count - before.manual.count,
      other: after.other.count - before.other.count,
      couponMicros: after.coupon.micros - before.coupon.micros,
      manualMicros: after.manual.micros - before.manual.micros,
      otherMicros: after.other.micros - before.other.micros,
    }).toEqual({
      coupon: 1,
      manual: 1,
      other: 1,
      couponMicros: 5_000_000,
      manualMicros: 7_000_000,
      otherMicros: 3_000_000,
    });

    // The verified-signup trial grant runs inside setup's own trigger and is
    // attributed to the new owner.
    const trialPerson = await insertAuthUser({ verified: true, provider: "credential" });
    const trialSetup = await completeSelfServiceOrganizationSetup(client.db, {
      authUserId: trialPerson.userId,
      actorSubjectId: trialPerson.subjectId,
      organizationName: remember("Lifecycle trial org"),
      operationId: crypto.randomUUID(),
      requestFingerprint: "d".repeat(64),
      trialCreditsEnabled: true,
    });
    const trial = await factsFor({
      type: "credits.granted",
      accountId: trialSetup.organizationId,
    });
    expect(trial.map((row) => [row.payload.attribute, row.initiator?.subjectId])).toEqual([
      ["signup_trial", trialPerson.subjectId],
    ]);
    const afterTrial = await readCreditGrantTotals(client.db);
    expect(afterTrial.signup_trial.count - after.signup_trial.count).toBe(1);
    expect(afterTrial.signup_trial.micros - after.signup_trial.micros).toBe(10_000_000);

    // Connection revocation and deletion of a live connection, with the same
    // provider class list as creation; an already revoked row is not counted twice.
    const person = `user:revoke-${crypto.randomUUID()}`;
    const target = await workspace("revoke", person);
    const connect = (providerDomain: string) =>
      createConnection(client!.db, {
        ...target,
        subjectId: null,
        providerDomain,
        kind: "api_key",
        credentialEncrypted: remember(`revoke-ciphertext-${crypto.randomUUID()}`),
        grantedScopes: [],
        metadata: {},
        createdBySubjectId: person,
      });
    const linear = await connect("linear.app");
    const custom = await connect(remember(`mcp.${crypto.randomUUID()}.customer-internal.example`));
    const revoked = await revokeConnection(client.db, target.workspaceId, linear.id, person);
    expect(revoked?.status).toBe("revoked");
    await revokeConnection(client.db, target.workspaceId, linear.id, person);
    await owned.admin`delete from connections where id = ${linear.id}`;
    await owned.admin`delete from connections where id = ${custom.id}`;
    const revocations = await factsFor({
      type: "connection.revoked",
      accountId: target.accountId,
    });
    expect(
      revocations
        .map((row) => [row.payload.attribute, row.workspace_id, row.initiator?.subjectId ?? null])
        .sort(),
    ).toEqual([
      ["linear", target.workspaceId, person],
      ["other", target.workspaceId, null],
    ]);
  });

  test("a capture failure never fails the product change", async () => {
    if (!owned) return;
    // Make validation (called from inside the capture's exception block) fail.
    const [original] = await owned.admin<{ definition: string }[]>`
      select pg_get_functiondef(
        'opengeni_private.product_lifecycle_fact_valid(text, text)'::regprocedure
      ) as definition`;
    await owned.admin.unsafe(`
      CREATE OR REPLACE FUNCTION opengeni_private.product_lifecycle_fact_valid(
        p_fact_type text, p_attribute text
      ) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog
      AS $$ BEGIN RAISE EXCEPTION 'simulated capture failure'; END $$`);
    try {
      const person = await insertAuthUser({ verified: true, provider: "credential" });
      const [stored] = await owned.admin<{ count: number }[]>`
        select count(*)::int as count from auth_users where id = ${person.userId}`;
      expect(stored?.count).toBe(1);
      expect(await factsFor({ type: "auth.sign_up", subjectId: person.subjectId })).toEqual([]);
    } finally {
      await owned.admin.unsafe(original!.definition);
    }
  });

  test("the export carries fixed, content-free facts and dead-letters them without content", async () => {
    if (!owned || !exporter) return;
    const rows = await lifecycleRows();
    expect(rows.length).toBeGreaterThan(15);
    for (const row of rows) {
      expect(Object.keys(row.payload).sort()).toEqual(["attribute", "factType", "subjectKind"]);
      expect(row.payload.factType).toBe(row.event_type);
      expect(row.session_id).toBeNull();
      expect(row.origin).toBeNull();
      expect(row.initiator_context).toEqual({});
      if (row.initiator) {
        expect(Object.keys(row.initiator).sort()).toEqual(["kind", "subjectId"]);
        expect(row.initiator.subjectId).toMatch(/^(user|api_key):[A-Za-z0-9_-]{8,128}$/);
      }
    }

    const batches: HostLifecycleFactExportBatch[] = [];
    let claimed: HostLifecycleFactExportBatch | null;
    do {
      claimed = await claimHostExportBatch(exporter.db, {
        kind: "lifecycle_fact",
        consumerId: CONSUMER,
        leaseToken: crypto.randomUUID(),
        leaseHolderId: "lifecycle-test",
        limit: 256,
      });
      if (!claimed) break;
      batches.push(claimed);
      await owned.admin`
        update host_export_consumers set checkpoint = lease_through, lease_token = null,
          lease_holder_id = null, lease_expires_at = null, lease_from = null, lease_through = null
        where export_kind = 'lifecycle_fact' and consumer_id = ${CONSUMER}`;
    } while (claimed);
    const facts = batches.flatMap((batch) => batch.events);
    expect(facts).toHaveLength(rows.length);
    const seen = new Set(facts.map((fact) => fact.fact.type));
    for (const type of PRODUCT_LIFECYCLE_FACT_TYPES) expect(seen.has(type)).toBe(true);
    for (const fact of facts) {
      expect(Object.keys(fact).sort()).toEqual([
        "accountId",
        "cursor",
        "fact",
        "idempotencyKey",
        "schemaRevision",
        "workspaceId",
      ]);
      expect(Object.keys(fact.fact).sort()).toEqual([
        "attribute",
        "id",
        "occurredAt",
        "subjectId",
        "subjectKind",
        "type",
      ]);
      expect(fact.idempotencyKey).toBe(`lifecycle_fact:${fact.fact.id}`);
    }
    const exported = JSON.stringify({ rows, batches });
    for (const value of personalValues) expect(exported).not.toContain(value);
    expect(exported).not.toContain("25000000");
    expect(exported).not.toContain("@");

    // A lifecycle head can be dead-lettered with the same content-free envelope.
    await insertAuthUser({ verified: true, provider: "google" });
    const leaseToken = crypto.randomUUID();
    const poison = await claimHostExportBatch(exporter.db, {
      kind: "lifecycle_fact",
      consumerId: CONSUMER,
      leaseToken,
      leaseHolderId: "lifecycle-test",
      limit: 1,
    });
    expect(poison?.events).toHaveLength(1);
    await deadLetterHostExportHead(exporter.db, {
      kind: "lifecycle_fact",
      consumerId: CONSUMER,
      leaseToken,
      cursor: poison!.events[0]!.cursor,
      reason: "lifecycle test disposition",
    });
    const [dead] = await owned.admin<{ envelope: Record<string, unknown> }[]>`
      select envelope from host_export_dead_letters
      where export_kind = 'lifecycle_fact' and consumer_id = ${CONSUMER}`;
    expect(Object.keys(dead!.envelope).sort()).toEqual([
      "accountId",
      "cursor",
      "fact",
      "idempotencyKey",
      "schemaRevision",
      "workspaceId",
    ]);
    for (const value of personalValues) expect(JSON.stringify(dead)).not.toContain(value);

    // Disabling the last lifecycle consumer closes the gate again.
    await disableHostExportConsumer(exporter.db, { kind: "lifecycle_fact", consumerId: CONSUMER });
    const before = (await lifecycleRows()).length;
    await insertAuthUser({ verified: true, provider: "credential" });
    expect(await lifecycleRows()).toHaveLength(before);
  });
});
