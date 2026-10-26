import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  claimAnsweredAgentCallForRealtimeInTransaction,
  claimNativePushDeliveries,
  createDb,
  createSession,
  createWorkspaceWebhook,
  getAgentCall,
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
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const MIGRATION = "0988_agent_calls.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(60_000);

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("agent-calls");
  if (!owned) {
    if (requireRealDatabase) throw new Error("agent calls PostgreSQL fixture is unavailable");
    return;
  }
  // Owner-run functions must work under FORCE RLS exactly as in production.
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

/** A person signed in to the phone app, in a workspace of their own, with a chat they started. */
async function person(label: string) {
  const userId = crypto.randomUUID();
  const subjectId = `user:${userId}`;
  await owned!.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${`Call ${label}`}, ${`call-${userId}@example.test`}, true)`;
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
  async function phone(): Promise<string> {
    const authSessionId = crypto.randomUUID();
    await owned!.admin`
      insert into auth_sessions (
        id, user_id, token, expires_at, user_agent,
        identity_id, identity_revision, auth_revision, login_binding_id, login_binding_revision
      ) values (
        ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '7 days',
        'OpenGeni app (iOS)', ${projection.activeIdentity.id},
        ${projection.activeIdentity.identityRevision}, ${projection.activeIdentity.authRevision},
        ${binding.id}, ${binding.revision}
      )`;
    return authSessionId;
  }
  const access = await bootstrapWorkspace(db(), {
    accountExternalSource: "migration-0988",
    accountExternalId: `account:${label}:${crypto.randomUUID()}`,
    accountName: `Call ${label}`,
    workspaceExternalSource: "migration-0988",
    workspaceExternalId: `workspace:${label}:${crypto.randomUUID()}`,
    workspaceName: `Call ${label}`,
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

async function iPhone(
  authSessionId: string,
  rules: ("call" | "call_members" | "failed")[],
  voipToken: string | null = "f".repeat(64),
) {
  return await registerNativePushDevice(db(), {
    authSessionId,
    platform: "ios",
    appId: "ai.opengeni.app",
    environment: "development",
    token: crypto.randomUUID().replace(/-/g, "").repeat(2),
    rules,
    voipToken,
  });
}

async function rings(authSessionId: string) {
  return await owned!.admin<Array<{ rule: string; payload: Record<string, unknown> }>>`
    select rule, payload from opengeni_private.native_push_deliveries
    where auth_session_id = ${authSessionId} and rule = 'call'
    order by created_at`;
}

function call(p: Awaited<ReturnType<typeof person>>, extra: { ringSeconds?: number } = {}) {
  return placeAgentCall(db(), {
    ...p.scope,
    sessionId: p.session.id,
    calleeSubjectId: p.subjectId,
    callerSubjectId: null,
    callerLabel: "Deploy watcher",
    reason: "Production is down",
    member: false,
    ...extra,
  });
}

describe("0988 agent calls", () => {
  test("is a rolling migration with private, owner-run functions", async () => {
    if (!client) return;
    const source = await Bun.file(new URL(`../drizzle/${MIGRATION}`, import.meta.url)).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION)\b/i);
    const rows = await owned!.admin<
      Array<{
        name: string;
        securityDefiner: boolean;
        config: string[] | null;
        publicExecute: boolean;
      }>
    >`
      select procedure.proname as name, procedure.prosecdef as "securityDefiner",
        procedure.proconfig as config,
        exists (
          select 1 from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'opengeni_private'
        and (procedure.proname like 'agent\\_call%' or procedure.proname = 'ring_agent_call_v1')`;
    expect(rows.map((row) => row.name).sort()).toEqual([
      "agent_call_device_count_v1",
      "agent_call_ringing_v1",
      "ring_agent_call_v1",
    ]);
    for (const row of rows) {
      expect(row.securityDefiner).toBe(true);
      expect(row.publicExecute).toBe(false);
      expect(row.config?.some((entry) => entry.startsWith("search_path="))).toBe(true);
    }
  });

  test("call rules need a PushKit token on iOS, and teammates' calls need the person's own", async () => {
    if (!client) return;
    const p = await person("rules");
    const withoutVoip = await iPhone(await p.phone(), ["call", "failed"], null);
    expect(withoutVoip.rules).toEqual(["failed"]);
    const membersOnly = await iPhone(await p.phone(), ["call_members"]);
    expect(membersOnly.rules).toEqual([]);
    const both = await iPhone(await p.phone(), ["call", "call_members"]);
    expect([...both.rules].sort()).toEqual(["call", "call_members"]);
  });

  test("nothing rings without a phone that allows calls", async () => {
    if (!client) return;
    const p = await person("no-phone");
    await iPhone(await p.phone(), ["failed"]);
    expect(await call(p)).toEqual({ placed: false, refusal: "no_phone" });
    // A teammate's agent needs call_members, not just call.
    await iPhone(await p.phone(), ["call"]);
    expect(
      await placeAgentCall(db(), {
        ...p.scope,
        sessionId: p.session.id,
        calleeSubjectId: p.subjectId,
        callerSubjectId: "user:someone-else",
        callerLabel: "Someone",
        reason: "Quick question",
        member: true,
      }),
    ).toEqual({ placed: false, refusal: "no_phone" });
  });

  test("rings every opted-in phone once, with the VoIP token, and the first answer wins", async () => {
    if (!client) return;
    const p = await person("ring");
    const phoneA = await p.phone();
    const phoneB = await p.phone();
    const quiet = await p.phone();
    await iPhone(phoneA, ["call"], "a".repeat(64));
    await iPhone(phoneB, ["call"], "b".repeat(64));
    await iPhone(quiet, ["failed"]);
    const placed = await call(p);
    if (!placed.placed) throw new Error(`expected a call, got ${placed.refusal}`);
    expect(placed.call).toMatchObject({
      state: "ringing",
      devices: 2,
      reason: "Production is down",
    });
    const [ring] = await rings(phoneA);
    expect(ring?.payload).toMatchObject({
      rule: "call",
      callId: placed.call.id,
      sessionId: p.session.id,
      title: "Deploy watcher",
      body: "Production is down",
    });
    expect(typeof ring?.payload.ringUntil).toBe("string");
    expect(await rings(phoneB)).toHaveLength(1);
    expect(await rings(quiet)).toHaveLength(0);
    const claimed = await claimNativePushDeliveries(db(), {
      claimId: crypto.randomUUID(),
      limit: 100,
    });
    const mine = claimed.filter((delivery) => delivery.payload.callId === placed.call.id);
    expect(mine.map((delivery) => delivery.voipToken).sort()).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);

    // One call rings a person at a time.
    expect(await call(p)).toEqual({ placed: false, refusal: "busy" });

    const answered = await settleAgentCall(db(), {
      ...p.scope,
      callId: placed.call.id,
      outcome: "answered",
      calleeSubjectId: p.subjectId,
      answeredBy: phoneA,
    });
    expect(answered).toMatchObject({ state: "answered", answeredBy: phoneA });
    expect(
      await settleAgentCall(db(), {
        ...p.scope,
        callId: placed.call.id,
        outcome: "answered",
        calleeSubjectId: p.subjectId,
        answeredBy: phoneB,
      }),
    ).toBeNull();

    // The voice call that opens next in this chat claims the answered call once.
    const realtimeId = crypto.randomUUID();
    const opened = await withRlsContext(db(), p.scope, (scoped) =>
      claimAnsweredAgentCallForRealtimeInTransaction(scoped, {
        ...p.scope,
        sessionId: p.session.id,
        calleeSubjectId: p.subjectId,
        realtimeId,
      }),
    );
    expect(opened).toMatchObject({ id: placed.call.id, realtimeId });
    const again = await withRlsContext(db(), p.scope, (scoped) =>
      claimAnsweredAgentCallForRealtimeInTransaction(scoped, {
        ...p.scope,
        sessionId: p.session.id,
        calleeSubjectId: p.subjectId,
        realtimeId: crypto.randomUUID(),
      }),
    );
    expect(again).toBeNull();
  });

  test("only the callee answers or declines, and a decline holds that chat off", async () => {
    if (!client) return;
    const p = await person("decline");
    await iPhone(await p.phone(), ["call"]);
    const placed = await call(p);
    if (!placed.placed) throw new Error(placed.refusal);
    expect(
      await settleAgentCall(db(), {
        ...p.scope,
        callId: placed.call.id,
        outcome: "declined",
        calleeSubjectId: "user:not-the-callee",
      }),
    ).toBeNull();
    expect(
      await settleAgentCall(db(), {
        ...p.scope,
        callId: placed.call.id,
        outcome: "declined",
        calleeSubjectId: p.subjectId,
      }),
    ).toMatchObject({ state: "declined" });
    expect(await call(p)).toEqual({ placed: false, refusal: "declined_recently" });
  });

  test("a call counts as missed only after its ring and the late-answer grace, and a chat rings at most three times an hour", async () => {
    if (!client) return;
    const p = await person("missed");
    await iPhone(await p.phone(), ["call"]);
    const first = await call(p, { ringSeconds: 1 });
    if (!first.placed) throw new Error(first.refusal);
    const settle = () =>
      settleAgentCall(db(), { ...p.scope, callId: first.call.id, outcome: "missed" });
    expect(await settle()).toBeNull();
    await Bun.sleep(6_300);
    expect(await settle()).toMatchObject({ state: "missed" });
    // A rung-out call no longer counts as ringing for the next one.
    for (let index = 0; index < 2; index += 1) {
      const next = await call(p);
      if (!next.placed) throw new Error(next.refusal);
      await settleAgentCall(db(), { ...p.scope, callId: next.call.id, outcome: "cancelled" });
    }
    expect(await call(p)).toEqual({ placed: false, refusal: "rate_limited" });
    expect(await getAgentCall(db(), { ...p.scope, callId: first.call.id })).toMatchObject({
      state: "missed",
    });
  });

  test("workspace webhooks can follow calls with their bounded fields", async () => {
    if (!client) return;
    const p = await person("webhook");
    await createWorkspaceWebhook(db(), {
      ...p.scope,
      url: "https://example.test/hooks",
      secretEncrypted: "encrypted",
      eventTypes: ["session.agentCall.ringing", "session.agentCall.settled"],
      enabled: true,
      description: null,
      createdBySubjectId: p.subjectId,
    });
    const callId = crypto.randomUUID();
    await appendSessionEvents(db(), p.scope.workspaceId, p.session.id, [
      {
        type: "session.agentCall.ringing",
        payload: {
          callId,
          calleeSubjectId: p.subjectId,
          callerLabel: "Deploy watcher",
          reason: "Production is down",
          ringUntil: "2026-10-26T18:00:40.000Z",
          devices: 1,
        },
      },
      {
        type: "session.agentCall.settled",
        payload: {
          callId,
          calleeSubjectId: p.subjectId,
          reason: "Production is down",
          outcome: "missed",
        },
      },
    ]);
    const deliveries = await withRlsContext(
      db(),
      p.scope,
      async (scoped) =>
        (await scoped.execute(
          sql`select event_type, payload from workspace_webhook_deliveries
          where workspace_id = ${p.scope.workspaceId}::uuid order by (payload->>'sequence')::bigint`,
        )) as unknown as Array<{ event_type: string; payload: { data: Record<string, unknown> } }>,
    );
    const rows = Array.isArray(deliveries) ? deliveries : (deliveries as { rows: never[] }).rows;
    expect(rows.map((row) => row.event_type)).toEqual([
      "session.agentCall.ringing",
      "session.agentCall.settled",
    ]);
    expect(rows[0]!.payload.data).toEqual({
      callId,
      calleeSubjectId: p.subjectId,
      callerLabel: "Deploy watcher",
      reason: "Production is down",
      ringUntil: "2026-10-26T18:00:40.000Z",
    });
    expect(rows[1]!.payload.data).toEqual({
      callId,
      calleeSubjectId: p.subjectId,
      reason: "Production is down",
      outcome: "missed",
    });
  });
});
