/**
 * Migration 1344: opengeni_private.end_agent_call_rings_v1 stops a settled
 * call's ring on the callee's other phones. Rings not sent yet are withdrawn;
 * Android phones that rang get one `ended` push; iOS phones get none.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  acquireOwnerMigratedTestDatabase,
  grantDeferredRuntimeAccess,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  claimNativePushDeliveries,
  createDb,
  createSession,
  placeAgentCall,
  registerNativePushDevice,
  settleAgentCall,
  withRlsContext,
  type DbClient,
} from "../src/index";
import {
  ensureCanonicalHumanIdentityForAuthUser,
  getCanonicalHumanExactLoginBindingForAuthUser,
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "../src/canonical-human-identities";
import { rawRows } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const MIGRATION = "1344_agent_call_ring_end.sql";
const ROUTINE = "opengeni_private.end_agent_call_rings_v1(uuid)";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(60_000);

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("agent-call-ring-end");
  if (!owned) {
    if (requireRealDatabase)
      throw new Error("agent call ring end PostgreSQL fixture is unavailable");
    return;
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await client?.close();
  await owned?.release();
}, 60_000);

const db = () => client!.db;

/** A person with a workspace, a chat they started, and phones signed in to the app. */
async function person(label: string) {
  const userId = crypto.randomUUID();
  const subjectId = `user:${userId}`;
  await owned!.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${`Ring ${label}`}, ${`ring-${userId}@example.test`}, true)`;
  await owned!.admin`
    insert into auth_identities (id, user_id, account_id, provider_id, created_at, updated_at)
    values (${crypto.randomUUID()}, ${userId}, ${userId}, 'credential', now(), now())`;
  await ensureCanonicalHumanIdentityForAuthUser(db(), userId);
  await synchronizeCanonicalHumanLoginBindings(db(), userId);
  const projection = await getCanonicalHumanIdentityProjection(db(), userId);
  const binding = await getCanonicalHumanExactLoginBindingForAuthUser(db(), {
    authUserId: userId,
    providerId: "credential",
  });
  async function phone(platform: "ios" | "android"): Promise<string> {
    const authSessionId = crypto.randomUUID();
    await owned!.admin`
      insert into auth_sessions (
        id, user_id, token, expires_at, user_agent,
        identity_id, identity_revision, auth_revision, login_binding_id, login_binding_revision
      ) values (
        ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '7 days',
        'OpenGeni app', ${projection.activeIdentity.id},
        ${projection.activeIdentity.identityRevision}, ${projection.activeIdentity.authRevision},
        ${binding.id}, ${binding.revision}
      )`;
    await registerNativePushDevice(db(), {
      authSessionId,
      platform,
      appId: "ai.opengeni.app",
      environment: "development",
      token: crypto.randomUUID().replace(/-/g, "").repeat(2),
      rules: ["call"],
      voipToken: platform === "ios" ? "f".repeat(64) : null,
    });
    return authSessionId;
  }
  const access = await bootstrapWorkspace(db(), {
    accountExternalSource: "migration-1343",
    accountExternalId: `account:${label}:${crypto.randomUUID()}`,
    accountName: `Ring ${label}`,
    workspaceExternalSource: "migration-1343",
    workspaceExternalId: `workspace:${label}:${crypto.randomUUID()}`,
    workspaceName: `Ring ${label}`,
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const session = await createSession(db(), {
    ...scope,
    initialMessage: `initial ${label}`,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId, label: `User ${label}` },
    createdByContext: { label: `User ${label}` },
  });
  return { scope, session, subjectId, phone };
}

async function ring(p: Awaited<ReturnType<typeof person>>) {
  const placed = await placeAgentCall(db(), {
    ...p.scope,
    sessionId: p.session.id,
    calleeSubjectId: p.subjectId,
    callerSubjectId: null,
    callerLabel: "Deploy watcher",
    reason: "Production is down",
    member: false,
  });
  if (!placed.placed) throw new Error(`expected a call, got ${placed.refusal}`);
  return placed.call;
}

/** Hand every queued push to the dispatcher, as if it were sending them now. */
async function sendQueued() {
  await claimNativePushDeliveries(db(), { claimId: crypto.randomUUID(), limit: 100 });
}

async function deliveries(authSessionId: string) {
  return await owned!.admin<
    Array<{ dedupeKey: string; failed: boolean; payload: Record<string, unknown> }>
  >`
    select dedupe_key as "dedupeKey", failed_at is not null as failed, payload
    from opengeni_private.native_push_deliveries
    where auth_session_id = ${authSessionId}
    order by created_at, dedupe_key`;
}

describe("1344 the end of a call's ring", () => {
  test("is a rolling migration whose private definer the runtime cannot run yet", async () => {
    if (!client) return;
    const source = await Bun.file(new URL(`../drizzle/${MIGRATION}`, import.meta.url)).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).not.toMatch(/\bGRANT\b/);
    const [routine] = await owned!.admin<
      Array<{ securityDefiner: boolean; config: string[] | null; publicExecute: boolean }>
    >`
      select procedure.prosecdef as "securityDefiner", procedure.proconfig as config,
        exists (
          select 1 from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute"
      from pg_proc procedure
      where procedure.oid = to_regprocedure(${ROUTINE})`;
    expect(routine).toMatchObject({ securityDefiner: true, publicExecute: false });
    expect(routine?.config?.some((entry) => entry.startsWith("search_path=pg_catalog,"))).toBe(
      true,
    );

    // Withheld: settling still works and stops nothing on the other phones.
    const p = await person("withheld");
    const android = await p.phone("android");
    const call = await ring(p);
    await sendQueued();
    expect(
      await settleAgentCall(db(), { ...p.scope, callId: call.id, outcome: "declined" }),
    ).toMatchObject({ state: "declined" });
    expect((await deliveries(android)).map((row) => row.dedupeKey)).toEqual([`call:${call.id}`]);
  });

  test("answering stops the ring: unsent rings are withdrawn, Android phones that rang get one ended push", async () => {
    if (!client) return;
    await grantDeferredRuntimeAccess(owned!.admin);
    const p = await person("answered");
    const rang = await p.phone("android");
    const unsent = await p.phone("android");
    const iPhone = await p.phone("ios");
    const call = await ring(p);
    await sendQueued();
    // This phone's ring has not been handed to the dispatcher yet.
    await owned!.admin`
      update opengeni_private.native_push_deliveries
      set claim_id = null, claimed_until = null, attempts = 0
      where auth_session_id = ${unsent}`;

    const answered = await settleAgentCall(db(), {
      ...p.scope,
      callId: call.id,
      outcome: "answered",
      calleeSubjectId: p.subjectId,
      answeredBy: iPhone,
    });
    expect(answered).toMatchObject({ state: "answered" });

    const ended = await deliveries(rang);
    expect(ended.map((row) => [row.dedupeKey, row.failed])).toEqual([
      [`call:${call.id}`, false],
      [`call-ended:${call.id}`, false],
    ]);
    expect(ended[1]!.payload).toEqual({
      rule: "call",
      callId: call.id,
      sessionId: p.session.id,
      workspaceId: p.scope.workspaceId,
      subjectId: p.subjectId,
      callEnded: "answeredElsewhere",
      ringUntil: expect.any(String),
    });
    expect(Date.parse(ended[1]!.payload.ringUntil as string)).toBe(Date.parse(call.ringUntil));
    expect((await deliveries(unsent)).map((row) => [row.dedupeKey, row.failed])).toEqual([
      [`call:${call.id}`, true],
    ]);
    expect((await deliveries(iPhone)).map((row) => row.dedupeKey)).toEqual([`call:${call.id}`]);

    // The dispatcher hands the ended push over like any other.
    const claimed = await claimNativePushDeliveries(db(), {
      claimId: crypto.randomUUID(),
      limit: 100,
    });
    expect(
      claimed
        .filter((delivery) => delivery.payload.callId === call.id)
        .map((delivery) => [delivery.platform, delivery.payload.callEnded]),
    ).toEqual([["android", "answeredElsewhere"]]);
  });

  test("a decline or the agent cancelling says why; another workspace ends nothing", async () => {
    if (!client) return;
    await grantDeferredRuntimeAccess(owned!.admin);
    const p = await person("declined");
    const android = await p.phone("android");
    const declinedCall = await ring(p);
    await sendQueued();
    await settleAgentCall(db(), {
      ...p.scope,
      callId: declinedCall.id,
      outcome: "declined",
      calleeSubjectId: p.subjectId,
    });
    // The decline cooldown holds this chat off; a second chat rings again.
    const other = await person("cancelled");
    const otherAndroid = await other.phone("android");
    const cancelledCall = await ring(other);
    await sendQueued();

    // A call in another workspace is invisible to this one.
    const ended = await withRlsContext(db(), p.scope, async (scoped) => {
      const [row] = await rawRows<{ queued: number }>(
        scoped,
        sql`select opengeni_private.end_agent_call_rings_v1(${cancelledCall.id}::uuid) as queued`,
      );
      return row;
    });
    expect(Number(ended?.queued)).toBe(0);

    await settleAgentCall(db(), { ...other.scope, callId: cancelledCall.id, outcome: "cancelled" });
    const reasons = async (authSessionId: string) =>
      (await deliveries(authSessionId))
        .filter((row) => row.dedupeKey.startsWith("call-ended:"))
        .map((row) => row.payload.callEnded);
    expect(await reasons(android)).toEqual(["declinedElsewhere"]);
    expect(await reasons(otherAndroid)).toEqual(["remoteEnded"]);
  });
});
