import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  applyCanonicalHumanIdentityOperation,
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "../src/canonical-human-identities";
import { createDb, nestedPostgresSqlState, type DbClient } from "../src";
import {
  acquireManagedAuthActorMutationLease,
  beginManagedAuthLoginTransaction,
  bootstrapManagedAuthSessionSet,
  completeManagedAuthLoginTransaction,
  getManagedAuthAdoptedSessionSnapshot,
  getManagedAuthSessionSetAuthorityState,
  getManagedAuthSessionSetSnapshot,
  ManagedAuthActorMutationInFlightError,
  ManagedAuthSessionSetOperationReuseError,
  mutateManagedAuthSessionSet,
  reapManagedAuthIsolatedSessions,
  reapExpiredManagedAuthSessionSets,
  releaseManagedAuthActorMutationLease,
  validateManagedAuthActorMutationLease,
} from "../src/managed-auth-session-sets";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { FORCE_RLS_TABLES, PROTECTED_NO_DIRECT_DML_TABLES } from "../src/runtime-posture";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let app: postgres.Sql | null = null;

type Login = {
  userId: string;
  identityId: string;
  identityRevision: number;
  authRevision: number;
  bindingId: string;
  bindingRevision: number;
  sessionId: string;
};

const hex = (value: string) => createHash("sha256").update(value).digest("hex");

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0356-managed-auth-session-sets");
  if (!owned) {
    if (requireRealDatabase) throw new Error("migration 0356 requires real PostgreSQL");
    return;
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, {
    appPassword: owned.appPassword,
    rlsStrategy: "force",
  });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 8, rlsStrategy: "force" });
  app = postgres(appUrl.toString(), { max: 4, prepare: false, onnotice: () => undefined });
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await app?.end({ timeout: 5 }).catch(() => undefined);
  await owned?.release();
}, 180_000);

async function createLogin(input: {
  label: string;
  identityId?: string;
  providerId?: string;
}): Promise<Login> {
  if (!owned || !client) throw new Error("test database unavailable");
  const userId = `session-set-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  const providerId = input.providerId ?? "credential";
  await owned.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${input.label}, ${email}, true)
  `;
  await owned.admin`
    insert into auth_identities (id, user_id, provider_id, account_id, created_at, updated_at)
    values (${crypto.randomUUID()}, ${userId}, ${providerId}, ${userId}, now(), now())
  `;
  if (input.identityId) {
    await owned.admin`
      insert into canonical_human_identity_subjects (auth_user_id, identity_id)
      values (${userId}, ${input.identityId}::uuid)
    `;
    await owned.admin`
      insert into canonical_human_login_bindings (
        identity_id, provider_id, provider_account_id, status
      ) values (${input.identityId}::uuid, ${providerId}, ${userId}, 'active')
    `;
  } else {
    await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  }
  const projection = await getCanonicalHumanIdentityProjection(client.db, userId);
  const binding = projection.loginBindings.find(
    (candidate) => candidate.providerId === providerId && candidate.providerAccountId === userId,
  );
  if (!binding) throw new Error("exact login binding was not created");
  const sessionId = crypto.randomUUID();
  await owned.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision,
      login_binding_id, login_binding_revision
    ) values (
      ${sessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${projection.activeIdentity.id}::uuid, ${projection.activeIdentity.identityRevision},
      ${projection.activeIdentity.authRevision}, ${binding.id}::uuid, ${binding.revision}
    )
  `;
  return {
    userId,
    identityId: projection.activeIdentity.id,
    identityRevision: projection.activeIdentity.identityRevision,
    authRevision: projection.activeIdentity.authRevision,
    bindingId: binding.id,
    bindingRevision: binding.revision,
    sessionId,
  };
}

async function bootstrap(authority: string, sessionId: string) {
  if (!client) throw new Error("test database unavailable");
  return await bootstrapManagedAuthSessionSet(client.db, {
    authorityHash: hex(authority),
    csrfHash: hex(`csrf:${authority}`),
    authSessionId: sessionId,
    mode: "broker",
    operationId: crypto.randomUUID(),
    requestDigest: hex(`bootstrap:${authority}`),
    expectedGeneration: "1",
    expectedActorEpoch: "1",
  });
}

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

describe("migration 0356 managed browser session sets", () => {
  test("pins the restricted runtime posture and exposes only definer routines", async () => {
    for (const table of [
      "managed_auth_browser_installations",
      "managed_auth_session_sets",
      "managed_auth_login_slots",
      "managed_auth_login_transactions",
      "managed_auth_login_return_intents",
      "managed_auth_session_set_operations",
      "managed_auth_actor_mutation_leases",
    ] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(table);
    }
    if (!app) return;
    await expectSqlState(() => app!`select * from managed_auth_session_sets`, "42501");
    await expectSqlState(
      () =>
        app!`insert into managed_auth_browser_installations (authority_hash) values (${hex("direct")})`,
      "42501",
    );
    expect(await getManagedAuthSessionSetAuthorityState(client!.db, hex("absent"))).toBe("absent");
  });

  test("validates an explicitly stamped provider-neutral login binding", async () => {
    if (!owned || !client) return;
    const github = await createLogin({ label: "GitHub Login", providerId: "github" });
    const credential = await createLogin({ label: "Credential Login" });

    const [stamped] = await owned.admin<Array<{ bindingId: string; bindingRevision: string }>>`
      select login_binding_id as "bindingId",
        login_binding_revision::text as "bindingRevision"
      from auth_sessions where id = ${github.sessionId}
    `;
    expect(stamped).toEqual({
      bindingId: github.bindingId,
      bindingRevision: String(github.bindingRevision),
    });

    await expectSqlState(
      () =>
        owned!.admin`
          insert into auth_sessions (
            id, user_id, token, expires_at, identity_id, identity_revision, auth_revision,
            login_binding_id, login_binding_revision
          ) values (
            ${crypto.randomUUID()}, ${github.userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
            ${github.identityId}::uuid, ${github.identityRevision}, ${github.authRevision},
            ${credential.bindingId}::uuid, ${credential.bindingRevision}
          )
        `,
      "42501",
    );
    await expectSqlState(
      () =>
        owned!.admin`
          insert into auth_sessions (
            id, user_id, token, expires_at, identity_id, identity_revision, auth_revision,
            login_binding_id, login_binding_revision
          ) values (
            ${crypto.randomUUID()}, ${github.userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
            ${github.identityId}::uuid, ${github.identityRevision}, ${github.authRevision},
            ${github.bindingId}::uuid, ${github.bindingRevision + 1}
          )
        `,
      "42501",
    );
  });

  test("materializes an empty broker set only on the first fenced add transaction", async () => {
    if (!owned || !client) return;
    const authority = `authority-${crypto.randomUUID()}`;
    const authorityHash = hex(authority);
    const operationId = crypto.randomUUID();
    const transactionId = crypto.randomUUID();
    const input = {
      authorityHash,
      csrfHash: hex(`csrf:${authority}`),
      operationId,
      requestDigest: hex("begin-greenfield-broker-add"),
      expectedGeneration: "1",
      expectedActorEpoch: "1",
      transactionId,
      transactionSecretHash: hex(`secret:${transactionId}`),
      kind: "add" as const,
      targetSlotId: null,
      returnIntentId: null,
      returnPath: null,
      expiresAt: new Date(Date.now() + 300_000),
    };

    expect(await getManagedAuthSessionSetAuthorityState(client.db, authorityHash)).toBe("absent");
    const begun = await beginManagedAuthLoginTransaction(client.db, input);
    expect(begun).toMatchObject({ id: transactionId, kind: "add", returnIntentId: null });
    expect(await getManagedAuthSessionSetAuthorityState(client.db, authorityHash)).toBe("active");
    expect(
      (
        await getManagedAuthSessionSetSnapshot(client.db, {
          authorityHash,
          mode: "broker",
          readOnly: true,
        })
      )?.projection,
    ).toMatchObject({
      generation: "1",
      actorEpoch: "1",
      selectedSlotId: null,
      state: "ready",
      slots: [],
    });

    const replay = await beginManagedAuthLoginTransaction(client.db, {
      ...input,
      transactionId: crypto.randomUUID(),
    });
    expect(replay).toEqual(begun);
    const [counts] = await owned.admin<
      Array<{ sets: string; transactions: string; operations: string }>
    >`
      select
        (select count(*)::text from managed_auth_session_sets
          where authority_hash = ${authorityHash}) as sets,
        (select count(*)::text from managed_auth_login_transactions
          where session_set_id = (select id from managed_auth_session_sets
            where authority_hash = ${authorityHash})) as transactions,
        (select count(*)::text from managed_auth_session_set_operations
          where operation_id = ${operationId}::uuid) as operations
    `;
    expect(counts).toEqual({ sets: "1", transactions: "1", operations: "1" });

    const reauthAuthority = hex(`reauth-authority-${crypto.randomUUID()}`);
    await expect(
      beginManagedAuthLoginTransaction(client.db, {
        ...input,
        authorityHash: reauthAuthority,
        operationId: crypto.randomUUID(),
        transactionId: crypto.randomUUID(),
        requestDigest: hex("begin-greenfield-broker-reauth"),
        kind: "reauth",
        targetSlotId: crypto.randomUUID(),
      }),
    ).rejects.toBeTruthy();
    expect(await getManagedAuthSessionSetAuthorityState(client.db, reauthAuthority)).toBe("absent");
  });

  test("keeps same-human exact login bindings in independent slots without changing selection", async () => {
    if (!owned || !client) return;
    const first = await createLogin({ label: "Shared Human A" });
    const second = await createLogin({ label: "Shared Human B", identityId: first.identityId });
    const authority = `authority-${crypto.randomUUID()}`;
    const initial = await bootstrap(authority, first.sessionId);
    const transactionId = crypto.randomUUID();
    const transactionSecret = `secret-${crypto.randomUUID()}`;
    await beginManagedAuthLoginTransaction(client.db, {
      authorityHash: hex(authority),
      csrfHash: hex(`csrf:${authority}`),
      operationId: crypto.randomUUID(),
      requestDigest: hex("begin-add-second-binding"),
      expectedGeneration: initial.generation,
      expectedActorEpoch: initial.actorEpoch,
      transactionId,
      transactionSecretHash: hex(transactionSecret),
      kind: "add",
      targetSlotId: null,
      returnIntentId: null,
      returnPath: null,
      expiresAt: new Date(Date.now() + 300_000),
    });
    const completed = await completeManagedAuthLoginTransaction(client.db, {
      authorityHash: hex(authority),
      csrfHash: hex(`csrf:${authority}`),
      operationId: crypto.randomUUID(),
      requestDigest: hex("complete-add-second-binding"),
      expectedGeneration: initial.generation,
      expectedActorEpoch: initial.actorEpoch,
      transactionId,
      transactionSecretHash: hex(transactionSecret),
      authSessionId: second.sessionId,
      mode: "broker",
    });
    expect(completed.projection.selectedSlotId).toBe(initial.selectedSlotId);
    expect(completed.projection.actorEpoch).toBe(initial.actorEpoch);
    const rows = await owned.admin<{ identityId: string; bindingId: string; selected: boolean }[]>`
      select slot.identity_id as "identityId", slot.login_binding_id as "bindingId",
        slot.id = session_set.selected_slot_id as selected
      from managed_auth_login_slots slot
      inner join managed_auth_session_sets session_set on session_set.id = slot.session_set_id
      where session_set.authority_hash = ${hex(authority)} and slot.status <> 'revoked'
      order by slot.created_at, slot.id
    `;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.identityId))).toEqual(new Set([first.identityId]));
    expect(new Set(rows.map((row) => row.bindingId)).size).toBe(2);
    expect(rows.filter((row) => row.selected)).toHaveLength(1);
  });

  test("rejects foreign-set selection and blocks actor transitions behind live mutation leases", async () => {
    if (!owned || !client) return;
    const first = await createLogin({ label: "Fence A" });
    const second = await createLogin({ label: "Fence B" });
    const authorityA = `authority-${crypto.randomUUID()}`;
    const authorityB = `authority-${crypto.randomUUID()}`;
    const projectionA = await bootstrap(authorityA, first.sessionId);
    await bootstrap(authorityB, second.sessionId);
    const [foreignSlot] = await owned.admin<{ id: string }[]>`
      select slot.id from managed_auth_login_slots slot
      inner join managed_auth_session_sets session_set on session_set.id = slot.session_set_id
      where session_set.authority_hash = ${hex(authorityB)}
    `;
    await expectSqlState(
      () => owned!.admin`
        update managed_auth_session_sets set selected_slot_id = ${foreignSlot!.id}::uuid
        where authority_hash = ${hex(authorityA)}
      `,
      "23503",
    );
    const requestId = crypto.randomUUID();
    await acquireManagedAuthActorMutationLease(client.db, {
      authorityHash: hex(authorityA),
      actorEpoch: projectionA.actorEpoch,
      requestId,
      leaseSeconds: 60,
    });
    expect(await getManagedAuthAdoptedSessionSnapshot(client.db, first.sessionId)).toMatchObject({
      authorityHash: hex(authorityA),
      actorEpoch: projectionA.actorEpoch,
      selected: { authSessionId: first.sessionId, authUserId: first.userId },
    });
    expect(
      await validateManagedAuthActorMutationLease(client.db, {
        authorityHash: hex(authorityA),
        actorEpoch: projectionA.actorEpoch,
        requestId,
      }),
    ).toBe(true);
    await expect(
      mutateManagedAuthSessionSet(client.db, {
        authorityHash: hex(authorityA),
        csrfHash: hex(`csrf:${authorityA}`),
        operationId: crypto.randomUUID(),
        requestDigest: hex("select-while-leased"),
        expectedGeneration: projectionA.generation,
        expectedActorEpoch: projectionA.actorEpoch,
        operationType: "select",
        targetSlotId: projectionA.selectedSlotId,
        mode: "broker",
      }),
    ).rejects.toBeInstanceOf(ManagedAuthActorMutationInFlightError);
    await releaseManagedAuthActorMutationLease(client.db, {
      authorityHash: hex(authorityA),
      requestId,
    });
    expect(
      await validateManagedAuthActorMutationLease(client.db, {
        authorityHash: hex(authorityA),
        actorEpoch: projectionA.actorEpoch,
        requestId,
      }),
    ).toBe(false);
  });

  test("reaps expired isolated provider sessions without touching an adopted session", async () => {
    if (!owned || !client) return;
    const login = await createLogin({ label: "Isolated Orphan" });
    const authority = `authority-${crypto.randomUUID()}`;
    const projection = await bootstrap(authority, login.sessionId);
    const transactionId = crypto.randomUUID();
    const transactionSecret = `secret-${crypto.randomUUID()}`;
    await beginManagedAuthLoginTransaction(client.db, {
      authorityHash: hex(authority),
      csrfHash: hex(`csrf:${authority}`),
      operationId: crypto.randomUUID(),
      requestDigest: hex("begin-orphan-attempt"),
      expectedGeneration: projection.generation,
      expectedActorEpoch: projection.actorEpoch,
      transactionId,
      transactionSecretHash: hex(transactionSecret),
      kind: "add",
      targetSlotId: null,
      returnIntentId: null,
      returnPath: null,
      expiresAt: new Date(Date.now() + 300_000),
    });
    const orphanId = crypto.randomUUID();
    await owned.admin`
      insert into auth_sessions (
        id, user_id, token, expires_at, identity_id, identity_revision, auth_revision,
        login_binding_id, login_binding_revision, managed_auth_login_transaction_id
      ) values (
        ${orphanId}, ${login.userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
        ${login.identityId}::uuid, ${login.identityRevision}, ${login.authRevision},
        ${login.bindingId}::uuid, ${login.bindingRevision}, ${transactionId}::uuid
      )
    `;
    await owned.admin`
      update managed_auth_login_transactions
      set status = 'cancelled', consumed_at = now()
      where id = ${transactionId}::uuid
    `;
    expect(await reapManagedAuthIsolatedSessions(client.db, 10)).toBe(1);
    const [orphan] = await owned.admin<{ exists: boolean }[]>`
      select exists(select 1 from auth_sessions where id = ${orphanId}) as exists
    `;
    expect(orphan).toEqual({ exists: false });

    await owned.admin`
      update auth_sessions set managed_auth_login_transaction_id = ${transactionId}::uuid
      where id = ${login.sessionId}
    `;
    expect(await reapManagedAuthIsolatedSessions(client.db, 10)).toBe(0);
    const [adopted] = await owned.admin<{ exists: boolean }[]>`
      select exists(select 1 from auth_sessions where id = ${login.sessionId}) as exists
    `;
    expect(adopted).toEqual({ exists: true });
  });

  test("pins reauthentication revisions and rejects a transaction begun before recovery", async () => {
    if (!owned || !client) return;
    const login = await createLogin({ label: "Recovery Pin" });
    const authority = `authority-${crypto.randomUUID()}`;
    const projection = await bootstrap(authority, login.sessionId);
    const txId = crypto.randomUUID();
    const txSecret = `secret-${crypto.randomUUID()}`;
    await beginManagedAuthLoginTransaction(client.db, {
      authorityHash: hex(authority),
      csrfHash: hex(`csrf:${authority}`),
      operationId: crypto.randomUUID(),
      requestDigest: hex("begin-stale-reauth"),
      expectedGeneration: projection.generation,
      expectedActorEpoch: projection.actorEpoch,
      transactionId: txId,
      transactionSecretHash: hex(txSecret),
      kind: "reauth",
      targetSlotId: projection.selectedSlotId,
      returnIntentId: null,
      returnPath: null,
      expiresAt: new Date(Date.now() + 300_000),
    });
    const [pinned] = await owned.admin<
      { identityRevision: string; authRevision: string; bindingRevision: string }[]
    >`
      select expected_identity_revision::text as "identityRevision",
        expected_auth_revision::text as "authRevision",
        expected_login_binding_revision::text as "bindingRevision"
      from managed_auth_login_transactions where id = ${txId}::uuid
    `;
    expect(pinned).toEqual({
      identityRevision: String(login.identityRevision),
      authRevision: String(login.authRevision),
      bindingRevision: String(login.bindingRevision),
    });
    await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: login.userId,
      expectedIdentityRevision: login.identityRevision,
      operationType: "begin_recovery",
      bindingId: login.bindingId,
      reason: "Exercise exact reauth revision pin",
    });
    const recovered = await getCanonicalHumanIdentityProjection(client.db, login.userId);
    const binding = recovered.loginBindings.find((candidate) => candidate.id === login.bindingId)!;
    const newSession = crypto.randomUUID();
    await owned.admin`
      insert into auth_sessions (
        id, user_id, token, expires_at, identity_id, identity_revision, auth_revision,
        login_binding_id, login_binding_revision
      ) values (
        ${newSession}, ${login.userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
        ${login.identityId}::uuid, ${recovered.activeIdentity.identityRevision},
        ${recovered.activeIdentity.authRevision}, ${login.bindingId}::uuid, ${binding.revision}
      )
    `;
    await expect(
      completeManagedAuthLoginTransaction(client.db, {
        authorityHash: hex(authority),
        csrfHash: hex(`csrf:${authority}`),
        operationId: crypto.randomUUID(),
        requestDigest: hex("complete-stale-reauth"),
        expectedGeneration: projection.generation,
        expectedActorEpoch: projection.actorEpoch,
        transactionId: txId,
        transactionSecretHash: hex(txSecret),
        authSessionId: newSession,
        mode: "broker",
      }),
    ).rejects.toBeTruthy();
  });

  test("returns to ready when a selected recovery slot logs out into an active replacement", async () => {
    if (!owned || !client) return;
    const recovering = await createLogin({ label: "Recovery Logout A" });
    const replacement = await createLogin({ label: "Recovery Logout B" });
    const authority = `authority-${crypto.randomUUID()}`;
    const initial = await bootstrap(authority, recovering.sessionId);
    const transactionId = crypto.randomUUID();
    const transactionSecret = `secret-${crypto.randomUUID()}`;
    await beginManagedAuthLoginTransaction(client.db, {
      authorityHash: hex(authority),
      csrfHash: hex(`csrf:${authority}`),
      operationId: crypto.randomUUID(),
      requestDigest: hex("begin-recovery-logout-replacement"),
      expectedGeneration: initial.generation,
      expectedActorEpoch: initial.actorEpoch,
      transactionId,
      transactionSecretHash: hex(transactionSecret),
      kind: "add",
      targetSlotId: null,
      returnIntentId: null,
      returnPath: null,
      expiresAt: new Date(Date.now() + 300_000),
    });
    const added = await completeManagedAuthLoginTransaction(client.db, {
      authorityHash: hex(authority),
      csrfHash: hex(`csrf:${authority}`),
      operationId: crypto.randomUUID(),
      requestDigest: hex("complete-recovery-logout-replacement"),
      expectedGeneration: initial.generation,
      expectedActorEpoch: initial.actorEpoch,
      transactionId,
      transactionSecretHash: hex(transactionSecret),
      authSessionId: replacement.sessionId,
      mode: "broker",
    });
    const replacementSlot = added.projection.slots.find(
      (slot) => slot.id !== initial.selectedSlotId,
    );
    expect(replacementSlot).toBeDefined();
    await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: recovering.userId,
      expectedIdentityRevision: recovering.identityRevision,
      operationType: "begin_recovery",
      bindingId: recovering.bindingId,
      reason: "Exercise recovery-slot replacement logout",
    });
    const recoverySnapshot = await getManagedAuthSessionSetSnapshot(client.db, {
      authorityHash: hex(authority),
      mode: "broker",
      allowRecovery: true,
      readOnly: true,
    });
    expect(recoverySnapshot?.projection).toMatchObject({
      selectedSlotId: initial.selectedSlotId,
      state: "actor_change_required",
    });
    const loggedOut = await mutateManagedAuthSessionSet(client.db, {
      authorityHash: hex(authority),
      csrfHash: hex(`csrf:${authority}`),
      operationId: crypto.randomUUID(),
      requestDigest: hex("logout-recovery-slot-with-replacement"),
      expectedGeneration: recoverySnapshot!.projection.generation,
      expectedActorEpoch: recoverySnapshot!.projection.actorEpoch,
      operationType: "logout_one",
      targetSlotId: initial.selectedSlotId,
      replacementSlotId: replacementSlot!.id,
      mode: "broker",
    });
    expect(loggedOut).toMatchObject({
      selectedSlotId: replacementSlot!.id,
      state: "ready",
    });
  });

  test("keeps read-only expiry checks side-effect free and exact logout replay terminal", async () => {
    if (!owned || !client) return;
    const login = await createLogin({ label: "Expiry And Replay" });
    const authority = `authority-${crypto.randomUUID()}`;
    await bootstrap(authority, login.sessionId);
    await owned.admin`
      update managed_auth_browser_installations installation set
        created_at = now() - interval '40 days',
        idle_expires_at = now() - interval '1 day',
        absolute_expires_at = now() + interval '100 days'
      from managed_auth_session_sets session_set
      where session_set.authority_hash = ${hex(authority)}
        and installation.id = session_set.installation_id
    `;
    expect(
      await getManagedAuthSessionSetSnapshot(client.db, {
        authorityHash: hex(authority),
        mode: "broker",
        readOnly: true,
      }),
    ).toBeNull();
    const [notRevoked] = await owned.admin<{ revoked: boolean }[]>`
      select revoked_at is not null as revoked from managed_auth_browser_installations
      where authority_hash = ${hex(authority)}
    `;
    expect(notRevoked).toEqual({ revoked: false });
    expect(await reapExpiredManagedAuthSessionSets(client.db, 10)).toBe(1);
    expect(
      await getManagedAuthSessionSetSnapshot(client.db, {
        authorityHash: hex(authority),
        mode: "broker",
      }),
    ).toBeNull();
    const [revoked] = await owned.admin<{ revoked: boolean }[]>`
      select revoked_at is not null as revoked from managed_auth_browser_installations
      where authority_hash = ${hex(authority)}
    `;
    expect(revoked).toEqual({ revoked: true });
    const [retired] = await owned.admin<{ sessionExists: boolean; slotRevoked: boolean }[]>`
      select exists(select 1 from auth_sessions where id = ${login.sessionId}) as "sessionExists",
        coalesce(bool_and(status = 'revoked' and auth_session_id is null), false) as "slotRevoked"
      from managed_auth_login_slots
      where session_set_id = (
        select id from managed_auth_session_sets where authority_hash = ${hex(authority)}
      )
    `;
    expect(retired).toEqual({ sessionExists: false, slotRevoked: true });

    const replayLogin = await createLogin({ label: "Logout Replay" });
    const replayAuthority = `authority-${crypto.randomUUID()}`;
    const live = await bootstrap(replayAuthority, replayLogin.sessionId);
    const operationId = crypto.randomUUID();
    const requestDigest = hex("logout-all-replay");
    const input = {
      authorityHash: hex(replayAuthority),
      csrfHash: hex(`csrf:${replayAuthority}`),
      operationId,
      requestDigest,
      expectedGeneration: live.generation,
      expectedActorEpoch: live.actorEpoch,
      operationType: "logout_all" as const,
      mode: "broker" as const,
    };
    const first = await mutateManagedAuthSessionSet(client.db, input);
    expect(await mutateManagedAuthSessionSet(client.db, input)).toEqual(first);
    await expect(
      mutateManagedAuthSessionSet(client.db, {
        ...input,
        requestDigest: hex("changed-logout-all-body"),
      }),
    ).rejects.toBeInstanceOf(ManagedAuthSessionSetOperationReuseError);
  });
});
