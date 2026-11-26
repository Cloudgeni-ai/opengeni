import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { ManagedEmailMessage } from "@opengeni/core";
import { dbSearchPath } from "@opengeni/config";
import { AccountDeletionPreview, StartAccountDeletionResponse } from "@opengeni/contracts";
import {
  acceptOrganizationInvitation,
  accountDeletionWork,
  claimOrganizationRetentionDeletion,
  completeOrganizationRetentionDeletion,
  createDb,
  createOrganizationInvitation,
  createSession,
  completeSelfServiceOrganizationSetup,
  ensureWorkspaceByExternalIdentity,
  enqueueSessionTurn,
  failOrganizationRetentionDeletion,
  finalizeOrganizationRetentionDeletion,
  listOrganizationRetentionDeletionObjects,
  previewOrganizationRetentionDeletions,
  recordOrganizationRetentionObjectDeleted,
  startAccountDeletion,
  updateOrganizationMember,
  upsertBillingCustomer,
  withRlsContext,
  type DbClient,
} from "@opengeni/db";
import {
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "@opengeni/db/canonical-human-identities";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createApp } from "../src/app";
import { createManagedAuth } from "../src/auth/managed-auth";
import { createBetterAuthSessionAdapter } from "../src/auth/managed-auth-session-adapter";
import { dropSiteSqlDatabases } from "../src/site-sql/service";
import { runOrganizationRetentionSweep } from "../../../scripts/sweep-organization-retention";

let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;
const origin = "http://opengeni.test";
const path = "/v1/me/account-deletion";

beforeAll(async () => {
  const fixture = await acquireRestrictedRuntimeTestDatabase("account-deletion-api");
  if (!fixture) throw new Error("Account deletion integration requires PostgreSQL");
  shared = fixture;
  await shared.admin`GRANT EXECUTE ON FUNCTION opengeni_private.account_deletion_user_v1(text,jsonb), opengeni_private.account_deletion_work_v1(text,jsonb) TO opengeni_app`;
  client = createDb(shared.appUrl, { rlsStrategy: "force", searchPath: shared.schema });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

function runtime(overrides: Parameters<typeof testSettings>[0] = {}) {
  const sent: ManagedEmailMessage[] = [];
  const deletedKeys: string[] = [];
  let sharedDeleteFailure = true;
  const authDatabaseUrl = new URL(shared.appUrl);
  authDatabaseUrl.searchParams.set(
    "options",
    `-c search_path=${dbSearchPath({ dbSchema: shared.schema })}`,
  );
  const settings = testSettings({
    productAccessMode: "managed",
    managedAuthSessionSetMode: "legacy",
    publicBaseUrl: origin,
    databaseUrl: authDatabaseUrl.toString(),
    dbSchema: shared.schema,
    betterAuthSecret: "account-deletion-test-secret-at-least-32-bytes",
    ...overrides,
  });
  const transport = {
    sender: "auth@example.test",
    idempotency: { scope: "test:account-deletion", retentionSeconds: 86_400 },
    send: async (message: ManagedEmailMessage) => {
      sent.push(message);
      return { status: "sent" as const, providerMessageId: "deleted" };
    },
  };
  const auth = createManagedAuth(settings, client.db, transport)!;
  const adapter = createBetterAuthSessionAdapter(auth, client.db);
  const app = createApp({
    settings,
    db: client.db,
    managedAuth: auth,
    managedAuthSessionAdapter: adapter,
    managedEmailTransport: transport,
    bus: new MemoryEventBus(),
    workflowClient: { startAccountDeletion: async () => {} } as never,
    objectStorage: {
      bucket: "test-account-deletion",
      deleteObject: async (key: string) => {
        if (key === "shared-key" && sharedDeleteFailure) {
          sharedDeleteFailure = false;
          throw new Error("Simulated object storage outage");
        }
        deletedKeys.push(key);
      },
    } as never,
  });
  return { app, adapter, sent, deletedKeys };
}

async function human(rt: ReturnType<typeof runtime>, { apple = false, relay = false } = {}) {
  const userId = crypto.randomUUID();
  const email = `${userId}@${relay ? "privaterelay.appleid.com" : "example.test"}`;
  await shared.admin`insert into auth_users(id,name,email,email_verified,image) values(${userId},'Example Human',${email},true,'https://example.test/avatar')`;
  const org = await completeSelfServiceOrganizationSetup(client.db, {
    authUserId: userId,
    actorSubjectId: `user:${userId}`,
    organizationName: "Example Organization",
    operationId: crypto.randomUUID(),
    requestFingerprint: "a".repeat(64),
  });
  const organizationId = org.organizationId;
  expect(organizationId).toBeTruthy();
  await shared.admin`insert into auth_identities(id,user_id,provider_id,account_id) values(${crypto.randomUUID()},${userId},'credential',${userId})`;
  if (apple) {
    await shared.admin`insert into auth_identities(id,user_id,provider_id,account_id)
      values(${crypto.randomUUID()},${userId},'apple',${crypto.randomUUID()})`;
  }
  await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  const projection = await getCanonicalHumanIdentityProjection(client.db, userId);
  const binding = projection.loginBindings.find((item) => item.providerId === "credential")!;
  async function newSession() {
    const token = randomBytes(24).toString("hex");
    const sessionId = crypto.randomUUID();
    await shared.admin`insert into auth_sessions(id,user_id,token,expires_at,identity_id,identity_revision,auth_revision,login_binding_id,login_binding_revision)
      values(${sessionId},${userId},${token},now()+interval '1 hour',${projection.activeIdentity.id},${projection.activeIdentity.identityRevision},${projection.activeIdentity.authRevision},${binding.id},${binding.revision})`;
    return { sessionId, token };
  }
  const browser = await newSession();
  const native = await newSession();
  const cookie = (
    await rt.adapter.createLegacySelectedSessionCookies({ token: browser.token } as never, null)
  )
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  return {
    userId,
    email,
    organizationId,
    personalWorkspaceId: org.personalWorkspaceId,
    cookie,
    native,
    browser,
    newSession,
  };
}

function request(
  rt: ReturnType<typeof runtime>,
  headers: Record<string, string>,
  operationId?: string,
) {
  return rt.app.request(
    path,
    operationId
      ? {
          method: "POST",
          headers: {
            ...headers,
            ...(headers.cookie ? { origin, "sec-fetch-site": "same-origin" } : {}),
            "content-type": "application/json",
          },
          body: JSON.stringify({ confirm: "DELETE", operationId }),
        }
      : { headers },
  );
}

test("the first release refuses account deletion before execution grants", async () => {
  const rt = runtime();
  const person = await human(rt);
  const browser = { cookie: person.cookie };
  await shared.admin`REVOKE EXECUTE ON FUNCTION opengeni_private.account_deletion_user_v1(text,jsonb), opengeni_private.account_deletion_work_v1(text,jsonb) FROM opengeni_app`;
  try {
    for (const response of [
      await request(rt, browser),
      await request(rt, browser, crypto.randomUUID()),
    ]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { details: { code: "ACCOUNT_DELETION_UNAVAILABLE" } },
      });
    }
    expect(
      await shared.admin`select id from account_deletion_requests where auth_user_id=${person.userId}`,
    ).toHaveLength(0);
    expect(
      await shared.admin`select id from auth_sessions where user_id=${person.userId}`,
    ).toHaveLength(2);
  } finally {
    await shared.admin`GRANT EXECUTE ON FUNCTION opengeni_private.account_deletion_user_v1(text,jsonb), opengeni_private.account_deletion_work_v1(text,jsonb) TO opengeni_app`;
  }
});

test("normal file CRUD still works under FORCE RLS and the runtime cannot forge a private inventory scope", async () => {
  const person = await human(runtime());
  const scope = { accountId: person.organizationId, workspaceId: person.personalWorkspaceId };
  const [hidden] =
    await shared.admin`insert into files(account_id,workspace_id,filename,safe_filename,status,content_type,size_bytes,bucket,object_key,private_owner_subject_ids)
    values(${scope.accountId},${scope.workspaceId},'private.txt','private.txt','available','text/plain',1,'test-account-deletion','private-key',ARRAY[${`user:${person.userId}`}]) returning id`;
  await withRlsContext(client.db, scope, async (tx) => {
    const [posture] = await tx.execute(
      sql`select current_user as role, row_security_active('files') as forced`,
    );
    expect(posture).toMatchObject({ role: "opengeni_app", forced: true });
    const [file] =
      await tx.execute(sql`insert into files(account_id,workspace_id,filename,safe_filename,status,content_type,size_bytes,bucket,object_key)
      values(${scope.accountId},${scope.workspaceId},'ordinary.txt','ordinary.txt','available','text/plain',1,'test-account-deletion','ordinary-key') returning id`);
    expect(file?.id).toBeTruthy();
    const objectId = String(file!.id);
    expect(await tx.execute(sql`select id from files where id=${objectId}`)).toMatchObject([
      { id: objectId },
    ]);
    expect(
      await tx.execute(sql`update files set size_bytes=2 where id=${objectId} returning id`),
    ).toMatchObject([{ id: objectId }]);
    await tx.execute(
      sql`select set_config('opengeni.account_deletion_file_inventory', ${scope.workspaceId}, true)`,
    );
    expect(await tx.execute(sql`select id from files where id=${String(hidden!.id)}`)).toHaveLength(
      0,
    );
    expect(
      await tx.execute(sql`delete from files where id=${objectId} returning id`),
    ).toMatchObject([{ id: objectId }]);
  });
});

test("cookie and native preview; admission is idempotent, revokes all sessions and erases a sole-member organization", async () => {
  const rt = runtime();
  const person = await human(rt);
  const ownedVerification = crypto.randomUUID();
  const legacyVerification = crypto.randomUUID();
  await shared.admin`insert into auth_verifications(id,identifier,value,expires_at) values
    (${ownedVerification},'managed-sign-in:test',${JSON.stringify({ authUserId: person.userId })},now()+interval '1 hour'),
    (${legacyVerification},'managed-sign-in:old',${String.raw`{"value":"\u0000"}`},now()+interval '1 hour')`;
  const [catalog] =
    await shared.admin`select to_regclass('ai_processing_consents') is not null as consent`;
  if (catalog?.consent) {
    await shared.admin`insert into ai_processing_consents(auth_user_id,disclosure_version,disclosure,platform,withdrawn_at)
      values (${person.userId},${"a".repeat(64)},'{}','ios',null),
        (${person.userId},${"b".repeat(64)},'{}','ios',clock_timestamp() + interval '1 second')`;
  }
  const { workspace } = await ensureWorkspaceByExternalIdentity(client.db, {
    accountId: person.organizationId,
    name: "Shared",
    externalSource: "test:account-closure",
    externalId: crypto.randomUUID(),
  });
  const serviceSession = await createSession(client.db, {
    accountId: person.organizationId,
    workspaceId: workspace.id,
    initialMessage: "Pending service work",
    resources: [],
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await enqueueSessionTurn(client.db, {
    accountId: person.organizationId,
    workspaceId: workspace.id,
    sessionId: serviceSession.id,
    triggerEventId: crypto.randomUUID(),
    temporalWorkflowId: `session-${serviceSession.id}`,
    source: "user",
    prompt: "Pending service work",
    resources: [],
    tools: [],
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    metadata: {},
    initiator: { kind: "service", subjectId: "service:account-deletion-test" },
  });
  expect(
    (await shared.admin`select status from sessions where id=${serviceSession.id}`)[0]?.status,
  ).toBe("queued");
  const [schedule] =
    await shared.admin`insert into scheduled_tasks (account_id,workspace_id,name,schedule,temporal_schedule_id,agent_config)
    values (${person.organizationId},${workspace.id},'Test schedule','{"type":"interval","everySeconds":60}',${crypto.randomUUID()},'{}') returning id`;
  const [source] =
    await shared.admin`insert into event_sources (account_id,workspace_id,name,kind,visibility,external_key,created_by_subject_id)
    values (${person.organizationId},${workspace.id},'Test source','github','workspace','test-account-deletion','service:account-deletion-test') returning id`;
  const [trigger] =
    await shared.admin`insert into event_triggers (account_id,workspace_id,task_id,source_id,position,event_types)
    values (${person.organizationId},${workspace.id},${schedule!.id},${source!.id},0,ARRAY['opened']) returning id`;
  for (const [workspaceId, key] of [
    [person.personalWorkspaceId, "personal-key"],
    [workspace.id, "shared-key"],
  ] as const) {
    await shared.admin`insert into files (account_id,workspace_id,filename,safe_filename,status,content_type,size_bytes,bucket,object_key)
      values (${person.organizationId},${workspaceId},'sample.txt','sample.txt','available','text/plain',10,'test-account-deletion',${key})`;
    const [site] =
      await shared.admin`insert into workspace_artifacts (account_id,workspace_id,slug,title,created_by_subject_id)
      values (${person.organizationId},${workspaceId},'delete-test','Test site',${`user:${person.userId}`}) returning id`;
    await shared.admin`insert into site_data_files (account_id,workspace_id,site_id,name,content_type,size_bytes,sha256,object_key,scope,owner_principal,created_by)
      values (${person.organizationId},${workspaceId},${site!.id},'sample.txt','text/plain',10,${"a".repeat(64)},${`site-${key}`},'shared','test','test')`;
    const artifactId = randomBytes(16).toString("hex");
    const stateHash = `sha256:${"a".repeat(64)}`;
    await shared.admin.begin(async (tx) => {
      // Fixture only: create small representative rows without invoking the
      // native document kernel. Erasure uses the real gates and constraints.
      await tx`set local session_replication_role = replica`;
      await tx`insert into editable_artifacts (account_id, workspace_id, id, modality, title, authorization_revision, state_hash, created_by_subject_id)
        values (${person.organizationId},${workspaceId},${artifactId},'document','An editable document',1,${stateHash},${`user:${person.userId}`})`;
      await tx`insert into editable_artifact_sequence_checkpoints (account_id, workspace_id, artifact_id, modality, head_sequence, native_revision, state_hash)
        values (${person.organizationId},${workspaceId},${artifactId},'document',0,0,${stateHash})`;
    });
  }
  const browser = { cookie: person.cookie };
  const native = { authorization: `Bearer ogapp_${person.native.token}` };
  const preview = await request(rt, browser);
  expect(preview.status).toBe(200);
  expect(AccountDeletionPreview.parse(await preview.json()).closeOrganizations).toMatchObject([
    { organizationId: person.organizationId },
  ]);
  expect((await request(rt, native)).status).toBe(200);
  expect((await request(rt, { authorization: "Bearer personal-api-key" })).status).toBe(401);
  expect(
    (
      await rt.app.request(path, {
        method: "POST",
        headers: {
          ...browser,
          origin: "https://other.example.test",
          "sec-fetch-site": "cross-site",
          "content-type": "application/json",
        },
        body: JSON.stringify({ confirm: "DELETE", operationId: crypto.randomUUID() }),
      })
    ).status,
  ).toBe(403);
  const operationId = crypto.randomUUID();
  const started = await request(rt, native, operationId);
  expect(started.status).toBe(202);
  const { request: receipt } = StartAccountDeletionResponse.parse(await started.json());
  expect(
    (await shared.admin`select status from scheduled_tasks where id=${schedule!.id}`)[0]?.status,
  ).toBe("paused");
  expect(
    (await shared.admin`select status from event_triggers where id=${trigger!.id}`)[0]?.status,
  ).toBe("disabled");
  const replay = await startAccountDeletion(client.db, {
    authUserId: person.userId,
    authSessionId: person.native.sessionId,
    operationId,
  });
  expect(replay.request).toEqual(receipt);
  expect((await request(rt, native, operationId)).status).toBe(401);
  expect((await request(rt, browser)).status).toBe(401);
  await expect(person.newSession()).rejects.toThrow("account is being deleted");
  const ticket = await accountDeletionWork(
    client.db,
    "ticket",
    { requestId: receipt.id },
    z.uuid(),
  );
  let retriedStorage = false;
  for (let i = 0; i < 24; i++) {
    const response = await rt.app.request(`/_og/internal/account-deletion/${receipt.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}` },
    });
    expect(response.status).toBe(200);
    const step = z
      .object({ done: z.boolean(), waitMs: z.number().optional() })
      .parse(await response.json());
    if (step.done) break;
    if (step.waitMs) {
      const [state] =
        await shared.admin`select status,blocked_step,progress from account_deletion_requests where id = ${receipt.id}`;
      if (!retriedStorage && state?.blocked_step === `workspace_cleanup:${workspace.id}`) {
        retriedStorage = true;
        expect(state.status).toBe("blocked");
        expect(rt.sent).toHaveLength(0);
        continue;
      }
      throw new Error(`Deletion did not advance: ${JSON.stringify(state)}`);
    }
  }
  const [erased] =
    await shared.admin`select u.name,u.email,u.image,r.status,r.email as receipt_email,
    (select count(*)::int from auth_identities where user_id=u.id) as login_methods,
    (select count(*)::int from workspaces where account_id=${person.organizationId}) as workspaces
    from auth_users u join account_deletion_requests r on r.auth_user_id=u.id where u.id=${person.userId}`;
  expect(erased).toEqual({
    name: "Deleted account",
    email: `deleted-${receipt.id}@account.invalid`,
    image: null,
    status: "completed",
    receipt_email: null,
    login_methods: 0,
    workspaces: 0,
  });
  expect(rt.sent).toMatchObject([{ kind: "account_deletion_completed", to: person.email }]);
  expect(
    await shared.admin`select id from auth_verifications where id in (${ownedVerification},${legacyVerification})`,
  ).toEqual([{ id: legacyVerification }]);
  if (catalog?.consent) {
    expect(
      await shared.admin`select id from ai_processing_consents where auth_user_id = ${person.userId}`,
    ).toHaveLength(0);
  }
  expect(rt.deletedKeys.sort()).toEqual([
    "personal-key",
    "shared-key",
    "site-personal-key",
    "site-shared-key",
  ]);
  expect(retriedStorage).toBe(true);
}, 90_000);

test("linked Apple credentials stay intact if revocation cannot run", async () => {
  const rt = runtime();
  const person = await human(rt, { apple: true, relay: true });
  const started = await request(rt, { cookie: person.cookie }, crypto.randomUUID());
  expect(started.status).toBe(202);
  const { request: receipt } = StartAccountDeletionResponse.parse(await started.json());
  const ticket = await accountDeletionWork(
    client.db,
    "ticket",
    { requestId: receipt.id },
    z.uuid(),
  );
  let paused = false;
  for (let step = 0; step < 12 && !paused; step++) {
    const response = await rt.app.request(`/_og/internal/account-deletion/${receipt.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}` },
    });
    paused = ((await response.json()) as { waitMs?: number }).waitMs === 300_000;
  }
  expect(paused).toBe(true);
  const [state] =
    await shared.admin`select status,blocked_step from account_deletion_requests where id = ${receipt.id}`;
  expect(state).toEqual({ status: "blocked", blocked_step: "apple" });
  const [identity] =
    await shared.admin`select provider_id from auth_identities where user_id = ${person.userId} and provider_id = 'apple'`;
  expect(identity).toEqual({ provider_id: "apple" });
  expect(
    await shared.admin`select id from workspaces where account_id=${person.organizationId}`,
  ).toHaveLength(0);
  expect(rt.sent).toMatchObject([{ to: person.email, subject: "Your Opengeni account deletion" }]);
  expect(rt.sent[0]?.text).toContain("We’re now removing your sign-in information");
}, 90_000);

test("closure inventories mode-specific Stripe customers and refuses to recreate their mappings", async () => {
  const rt = runtime({ stripeSecretKey: "sk_live_no_network_should_be_used" });
  const person = await human(rt);
  await upsertBillingCustomer(client.db, {
    accountId: person.organizationId,
    provider: "stripe:test",
    providerCustomerId: "cus_test_original",
  });
  const started = await request(rt, { cookie: person.cookie }, crypto.randomUUID());
  expect(started.status).toBe(202);
  const { request: receipt } = StartAccountDeletionResponse.parse(await started.json());
  const ticket = await accountDeletionWork(
    client.db,
    "ticket",
    { requestId: receipt.id },
    z.uuid(),
  );
  await upsertBillingCustomer(client.db, {
    accountId: person.organizationId,
    provider: "stripe:test",
    providerCustomerId: "cus_test_unexpected",
  });
  expect(
    await accountDeletionWork(
      client.db,
      "close_inventory",
      {
        requestId: receipt.id,
        ticket,
        organizationId: person.organizationId,
      },
      z.object({ stripeCustomers: z.array(z.object({ provider: z.string(), id: z.string() })) }),
    ),
  ).toEqual({
    stripeCustomers: [{ provider: "stripe:test", id: "cus_test_original" }],
  });
  let blocked = false;
  for (let step = 0; step < 12 && !blocked; step++) {
    const response = await rt.app.request(`/_og/internal/account-deletion/${receipt.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}` },
    });
    expect(response.status).toBe(200);
    blocked = ((await response.json()) as { done: boolean }).done;
  }
  expect(blocked).toBe(true);
  const [state] =
    await shared.admin`select status,blocked_reason,terminal_failure from account_deletion_requests where id = ${receipt.id}`;
  expect(state).toEqual({
    status: "blocked",
    blocked_reason: "stripe_mode_credentials_missing",
    terminal_failure: true,
  });
  const metrics = z.object({ blocked: z.number(), terminal: z.number(), overdue: z.number() });
  expect(
    (await shared.admin`select email from auth_users where id=${person.userId}`)[0]?.email,
  ).toBe(`deleted-${receipt.id}@account.invalid`);
  expect(rt.sent).toHaveLength(0);
  expect((await accountDeletionWork(client.db, "metrics", {}, metrics)).terminal).toBeGreaterThan(
    0,
  );
  const before = await accountDeletionWork(client.db, "due", {}, z.array(z.uuid()));
  expect(before).not.toContain(receipt.id);
  expect(
    await accountDeletionWork(
      client.db,
      "resume_blocked",
      { requestId: receipt.id, ticket },
      z.boolean(),
    ),
  ).toBe(true);
  expect(await accountDeletionWork(client.db, "due", {}, z.array(z.uuid()))).toContain(receipt.id);
}, 90_000);

test("sign-ins share the admission fence; the dispatcher rechecks even previously dispatched work", async () => {
  const rt = runtime();
  const person = await human(rt);
  await shared.admin.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`canonical-human-user:${person.userId}`}, 0))`;
    const signedIn = await person.newSession();
    expect(signedIn.sessionId).toBeTruthy();
  });
  const response = await request(rt, { cookie: person.cookie }, crypto.randomUUID());
  expect(response.status).toBe(202);
  const { request: receipt } = StartAccountDeletionResponse.parse(await response.json());
  await accountDeletionWork(client.db, "dispatched", { requestId: receipt.id }, z.null());
  await shared.admin`update account_deletion_requests set next_dispatch_check_at = now() - interval '1 second' where id = ${receipt.id}`;
  expect(await accountDeletionWork(client.db, "due", {}, z.array(z.uuid()))).toContain(receipt.id);
  expect(await accountDeletionWork(client.db, "due", {}, z.array(z.uuid()))).not.toContain(
    receipt.id,
  );
  const ticket = await accountDeletionWork(
    client.db,
    "ticket",
    { requestId: receipt.id },
    z.uuid(),
  );
  const [member] =
    await shared.admin`select id, personal_retention_until from organization_memberships
    where account_id=${person.organizationId} and subject_id=${`user:${person.userId}`}`;
  await shared.admin`insert into organization_user_retention_deletions(account_id,membership_id,retention_until,state,claim_operation_id,claim_expires_at)
    values(${person.organizationId},${member!.id},${member!.personal_retention_until},'claimed',${crypto.randomUUID()},now() + interval '10 minute')`;
  const advance = async () =>
    (
      await rt.app.request(`/_og/internal/account-deletion/${receipt.id}`, {
        method: "POST",
        headers: { authorization: `Bearer ${ticket}` },
      })
    ).json();
  const metrics = z.object({ terminal: z.number(), stalled: z.number() });
  const baseline = await accountDeletionWork(client.db, "metrics", {}, metrics);
  await shared.admin`update account_deletion_requests set last_progress_at=now()-interval '25 hours' where id=${receipt.id}`;
  expect((await accountDeletionWork(client.db, "metrics", {}, metrics)).stalled).toBe(
    baseline.stalled + 1,
  );
  expect(await advance()).toEqual({ done: false, waitMs: 0 });
  expect((await accountDeletionWork(client.db, "metrics", {}, metrics)).stalled).toBe(
    baseline.stalled,
  );
  expect(await advance()).toEqual({ done: false, waitMs: 0 });
  expect(await advance()).toEqual({ done: false, waitMs: 60_000 });
  const [status] =
    await shared.admin`select status,blocked_reason from account_deletion_requests where id = ${receipt.id}`;
  expect(status).toEqual({ status: "blocked", blocked_reason: "retention_claim_unavailable" });
  await shared.admin`update account_deletion_requests set blocked_since=now()-interval '25 hours' where id=${receipt.id}`;
  expect(await advance()).toEqual({ done: true, waitMs: 0 });
  expect((await accountDeletionWork(client.db, "metrics", {}, metrics)).terminal).toBe(
    baseline.terminal + 1,
  );
}, 90_000);

test("provisioning cannot create a seat during or after deletion, and a closed org cannot gain a Stripe customer", async () => {
  const rt = runtime();
  const person = await human(rt);
  const other = await human(rt);
  const newSeat =
    () => shared.admin`insert into organization_memberships(account_id,subject_id,status)
    values(${other.organizationId},${`user:${person.userId}`},'provisioning')`;
  await shared.admin.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`canonical-human-user:${person.userId}`},0))`;
    await expect(newSeat()).rejects.toThrow("person account is busy");
  });
  expect((await request(rt, { cookie: person.cookie }, crypto.randomUUID())).status).toBe(202);
  await expect(newSeat()).rejects.toThrow("organization or account is being deleted");
  for (const accountId of [person.organizationId, other.organizationId]) {
    await upsertBillingCustomer(client.db, {
      accountId,
      provider: "stripe:test",
      providerCustomerId: `cus_${accountId}`,
    });
  }
  expect(
    await shared.admin`select account_id from billing_customers where account_id in (${person.organizationId},${other.organizationId})`,
  ).toEqual([{ account_id: other.organizationId }]);
});

test("ordinary Postgres retention can settle Site SQL, but an older sweeper cannot acknowledge it", async () => {
  const rt = runtime();
  const owner = await human(rt);
  const member = await human(rt);
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: owner.organizationId,
    actorSubjectId: `user:${owner.userId}`,
    operationId: crypto.randomUUID(),
    targetSubjectId: `user:${member.userId}`,
    targetEmail: member.email,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(client.db, {
    organizationId: owner.organizationId,
    invitationId: invitation.id,
    actorSubjectId: `user:${member.userId}`,
    operationId: crypto.randomUUID(),
    expectedRevision: invitation.revision,
  });
  const [seat] =
    await shared.admin`select id,personal_workspace_id,authorization_revision from organization_memberships
    where account_id=${owner.organizationId} and subject_id=${`user:${member.userId}`}`;
  const [site] =
    await shared.admin`insert into workspace_artifacts(account_id,workspace_id,slug,title,created_by_subject_id)
    values(${owner.organizationId},${seat!.personal_workspace_id},'retention-site','Retained site',${`user:${member.userId}`}) returning id`;
  await shared.admin`insert into site_sql_databases(account_id,workspace_id,site_id,enabled,created_by,updated_by)
    values(${owner.organizationId},${seat!.personal_workspace_id},${site!.id},true,'test','test')`;
  await updateOrganizationMember(client.db, {
    organizationId: owner.organizationId,
    actorSubjectId: `user:${owner.userId}`,
    operationId: crypto.randomUUID(),
    membershipId: seat!.id,
    transition: { kind: "offboard", expectedAuthorizationRevision: seat!.authorization_revision },
  });
  await shared.admin`update organization_memberships set personal_retention_until=now()-interval '1 day' where id=${seat!.id}`;
  const result = await runOrganizationRetentionSweep(
    {
      organizationId: owner.organizationId,
      dryRun: false,
      limit: 1,
      objectBucket: "test-account-deletion",
    },
    {
      preview: (input) => previewOrganizationRetentionDeletions(client.db, input),
      claim: (input) => claimOrganizationRetentionDeletion(client.db, input),
      finalizeDatabase: (input) => finalizeOrganizationRetentionDeletion(client.db, input),
      listObjects: (input) => listOrganizationRetentionDeletionObjects(client.db, input),
      deleteObject: async () => {
        throw new Error("Site SQL is not an object storage key");
      },
      deleteSiteSql: async (id) => {
        expect(id).toBe(site!.id);
        expect((await dropSiteSqlDatabases({}, [id])).status).toBe("not_configured");
      },
      recordObjectDeleted: async (input) => {
        expect(input.objectKind).toBe("site_sql");
        await expect(
          recordOrganizationRetentionObjectDeleted(client.db, { ...input, siteSqlHandled: false }),
        ).rejects.toThrow();
        return recordOrganizationRetentionObjectDeleted(client.db, input);
      },
      complete: (input) => completeOrganizationRetentionDeletion(client.db, input),
      fail: (input) => failOrganizationRetentionDeletion(client.db, input),
      newOperationId: () => crypto.randomUUID(),
    },
  );
  expect(result).toMatchObject({
    dryRun: false,
    completed: [{ membershipId: seat!.id }],
    failed: [],
  });
  expect(
    await shared.admin`select site_id from site_sql_databases where site_id=${site!.id}`,
  ).toHaveLength(0);
}, 90_000);

test("both erasers cover every workspace-owned external object column", async () => {
  const sources = await shared.admin<
    { table_name: string; column_name: string }[]
  >`select table_name,column_name
    from information_schema.columns keys where keys.table_schema = ${shared.schema}
    and keys.column_name in ('object_key','object_reference','storage_key','manifest_key','tree_index_key','staging_object_key','content_key','blob_keys')
    and exists (select from information_schema.columns workspace where workspace.table_schema = keys.table_schema
      and workspace.table_name = keys.table_name and workspace.column_name = 'workspace_id')`;
  expect(sources.length).toBeGreaterThan(10);
  const [functions] =
    await shared.admin`select pg_get_functiondef('opengeni_private.account_deletion_work_v1(text,jsonb)'::regprocedure) as closure,
    pg_get_functiondef('opengeni_private.organization_retention_object_candidates(uuid,uuid)'::regprocedure) ||
    pg_get_functiondef('opengeni_private.organization_retention_file_candidates(uuid,uuid)'::regprocedure) as retention`;
  for (const storage of sources) {
    for (const definition of [functions?.closure, functions?.retention]) {
      expect(definition).toContain(storage.table_name);
      expect(definition).toContain(storage.column_name);
    }
  }
  expect(functions?.closure).toContain("site_sql_databases");
  expect(functions?.retention).toContain("site_sql_databases");
});

test("account deletion records that Site SQL cannot be erased without a gateway", async () => {
  const rt = runtime({ sitesGatewaySecret: undefined });
  const person = await human(rt);
  const [site] =
    await shared.admin`insert into workspace_artifacts(account_id,workspace_id,slug,title,created_by_subject_id)
    values(${person.organizationId},${person.personalWorkspaceId},'unconfigured-site','Test Site',${`user:${person.userId}`}) returning id`;
  await shared.admin`insert into site_sql_databases(account_id,workspace_id,site_id,enabled,created_by,updated_by)
    values(${person.organizationId},${person.personalWorkspaceId},${site!.id},true,'test','test')`;
  const response = await request(rt, { cookie: person.cookie }, crypto.randomUUID());
  expect(response.status).toBe(202);
  const { request: receipt } = StartAccountDeletionResponse.parse(await response.json());
  const ticket = await accountDeletionWork(
    client.db,
    "ticket",
    { requestId: receipt.id },
    z.uuid(),
  );
  let done = false;
  for (let index = 0; index < 8 && !done; index++) {
    const step = await rt.app.request(`/_og/internal/account-deletion/${receipt.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}` },
    });
    done = ((await step.json()) as { done: boolean }).done;
  }
  expect(done).toBe(true);
  const [state] =
    await shared.admin`select status,blocked_reason,terminal_failure from account_deletion_requests where id=${receipt.id}`;
  expect(state).toEqual({
    status: "blocked",
    blocked_reason: "site_sql_gateway_not_configured",
    terminal_failure: true,
  });
  expect(rt.sent).toHaveLength(0);
});

test("last owner must transfer ownership; an ordinary member can leave without closing the organization", async () => {
  const rt = runtime();
  const owner = await human(rt);
  const member = await human(rt);
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: owner.organizationId,
    actorSubjectId: `user:${owner.userId}`,
    operationId: crypto.randomUUID(),
    targetSubjectId: `user:${member.userId}`,
    targetEmail: member.email,
    targetName: "Example Human",
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(client.db, {
    organizationId: owner.organizationId,
    invitationId: invitation.id,
    actorSubjectId: `user:${member.userId}`,
    operationId: crypto.randomUUID(),
    expectedRevision: invitation.revision,
  });
  const denied = await request(rt, { cookie: owner.cookie }, crypto.randomUUID());
  expect(denied.status).toBe(409);
  expect(await denied.json()).toMatchObject({
    error: {
      details: {
        code: "LAST_ORGANIZATION_OWNER",
        blockers: [{ organizationId: owner.organizationId }],
      },
    },
  });
  expect((await request(rt, { cookie: owner.cookie })).status).toBe(200);
  const partner = await request(rt, { cookie: member.cookie });
  expect(partner.status).toBe(200);
  expect(AccountDeletionPreview.parse(await partner.json()).leaveOrganizations).toMatchObject([
    { organizationId: owner.organizationId },
  ]);
  const pending = await createOrganizationInvitation(client.db, {
    organizationId: owner.organizationId,
    actorSubjectId: `user:${owner.userId}`,
    operationId: crypto.randomUUID(),
    targetEmail: member.email,
    targetName: "Example Human",
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const untouched = await createOrganizationInvitation(client.db, {
    organizationId: owner.organizationId,
    actorSubjectId: `user:${owner.userId}`,
    operationId: crypto.randomUUID(),
    targetEmail: "other@example.test",
    targetName: "Other Invitee",
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const started = await request(rt, { cookie: member.cookie }, crypto.randomUUID());
  expect(started.status).toBe(202);
  const { request: receipt } = StartAccountDeletionResponse.parse(await started.json());
  const [retained] =
    await shared.admin`select status,personal_retention_until from organization_memberships where account_id=${owner.organizationId} and subject_id=${`user:${member.userId}`}`;
  expect(retained).toMatchObject({ status: "revoked", personal_retention_until: null });
  const ticket = await accountDeletionWork(
    client.db,
    "ticket",
    { requestId: receipt.id },
    z.uuid(),
  );
  let done = false;
  for (let step = 0; step < 16 && !done; step++) {
    const response = await rt.app.request(`/_og/internal/account-deletion/${receipt.id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}` },
    });
    expect(response.status).toBe(200);
    done = ((await response.json()) as { done: boolean }).done;
  }
  expect(done).toBe(true);
  const [redacted] =
    await shared.admin`select target_name, target_email, target_subject_id from organization_membership_invitations where id=${invitation.id}`;
  expect(redacted).toEqual({
    target_name: null,
    target_email: `deleted-${receipt.id}@account.invalid`,
    target_subject_id: null,
  });
  expect(
    await shared.admin`select id from organization_membership_invitations where id=${pending.id} and status='pending'`,
  ).toHaveLength(0);
  expect(
    (
      await shared.admin`select target_name from organization_membership_invitations where id=${untouched.id}`
    )[0]?.target_name,
  ).toBe("Other Invitee");
  expect(
    await shared.admin`select 1 from organization_membership_operation_receipts where result->>'targetEmail'=${member.email}`,
  ).toHaveLength(0);
}, 90_000);
