import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  claimNativePushDeliveries,
  createDb,
  createSession,
  enqueueNativePush,
  getNativePushDevice,
  registerNativePushDevice,
  settleNativePushDelivery,
  unregisterNativePushDevice,
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

const MIGRATION = "0638_native_app_push.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(60_000);

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("native-app-push");
  if (!owned) {
    if (requireRealDatabase) throw new Error("native push PostgreSQL fixture is unavailable");
    return;
  }
  // Migrate as the NOSUPERUSER NOBYPASSRLS owner so the owner-run functions and
  // the session-event trigger run under FORCE RLS exactly as in production.
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

/** A person signed in to the native app (a stamped app session), and a session they started. */
async function personWithAppSession(label: string) {
  const userId = crypto.randomUUID();
  const subjectId = `user:${userId}`;
  await owned!.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${`Push ${label}`}, ${`push-${userId}@example.test`}, true)`;
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
  const access = await bootstrapWorkspace(db(), {
    accountExternalSource: "migration-0638",
    accountExternalId: `account:${label}:${crypto.randomUUID()}`,
    accountName: `Push ${label}`,
    workspaceExternalSource: "migration-0638",
    workspaceExternalId: `workspace:${label}:${crypto.randomUUID()}`,
    workspaceName: `Push ${label}`,
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
  return { scope, session, subjectId, userId, authSessionId };
}

async function pendingFor(authSessionId: string) {
  return await owned!.admin<Array<{ rule: string; payload: Record<string, unknown> }>>`
    select rule, payload from opengeni_private.native_push_deliveries
    where auth_session_id = ${authSessionId} and delivered_at is null and failed_at is null
    order by created_at`;
}

describe("0638 native app push", () => {
  test("is a rolling, additive migration with private, owner-run storage", async () => {
    if (!client) return;
    const source = await Bun.file(new URL(`../drizzle/${MIGRATION}`, import.meta.url)).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION)\b/i);
    expect(source).not.toMatch(/\bALTER TABLE\s+"?session_events"?/i);
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
      where namespace.nspname = 'opengeni_private' and procedure.proname like '%native_push%'`;
    expect(rows.length).toBe(8);
    for (const row of rows) {
      expect(row.securityDefiner).toBe(true);
      expect(row.publicExecute).toBe(false);
      expect(row.config?.some((entry) => entry.startsWith("search_path="))).toBe(true);
    }
    // The application role cannot read the tables directly.
    const direct = async () =>
      await db().execute(sql`select count(*) from opengeni_private.native_push_devices`);
    await expect(direct()).rejects.toThrow();
  });

  test("registers against the app session and derives the person from it", async () => {
    if (!client) return;
    const person = await personWithAppSession("register");
    expect(await getNativePushDevice(db(), person.authSessionId)).toBeNull();
    const device = await registerNativePushDevice(db(), {
      authSessionId: person.authSessionId,
      platform: "ios",
      appId: "dev.opengeni.app",
      environment: "development",
      token: "a".repeat(64),
      rules: ["needs_input", "failed", "needs_input"],
    });
    expect(device).toMatchObject({ platform: "ios", rules: ["failed", "needs_input"] });
    const [row] = await owned!.admin<Array<{ subject: string }>>`
      select subject_id as subject from opengeni_private.native_push_devices
      where auth_session_id = ${person.authSessionId}`;
    expect(row?.subject).toBe(person.subjectId);
    await expect(
      registerNativePushDevice(db(), {
        authSessionId: crypto.randomUUID(),
        platform: "ios",
        appId: "dev.opengeni.app",
        environment: "development",
        token: "b".repeat(64),
        rules: ["failed"],
      }),
    ).rejects.toThrow();
    await unregisterNativePushDevice(db(), person.authSessionId);
    expect(await getNativePushDevice(db(), person.authSessionId)).toBeNull();
  });

  test("session events fan out by rule to the starter's devices only", async () => {
    if (!client) return;
    const person = await personWithAppSession("fanout");
    const other = await personWithAppSession("other");
    await registerNativePushDevice(db(), {
      authSessionId: person.authSessionId,
      platform: "ios",
      appId: "dev.opengeni.app",
      environment: "development",
      token: "c".repeat(64),
      rules: ["needs_input", "failed"],
    });
    await registerNativePushDevice(db(), {
      authSessionId: other.authSessionId,
      platform: "android",
      appId: "dev.opengeni.app",
      environment: "production",
      token: "d".repeat(64),
      rules: ["needs_input", "reply_ready", "failed"],
    });
    await appendSessionEvents(db(), person.scope.workspaceId, person.session.id, [
      {
        type: "session.humanInput.requested",
        payload: { request: { questions: [{ prompt: "Which branch?" }] } },
      },
      { type: "turn.completed", payload: {} },
      { type: "turn.failed", payload: { error: "boom" } },
    ]);
    const mine = await pendingFor(person.authSessionId);
    expect(mine.map((row) => row.rule)).toEqual(["needs_input", "failed"]);
    expect(mine[0]!.payload).toMatchObject({
      sessionId: person.session.id,
      workspaceId: person.scope.workspaceId,
      subjectId: person.subjectId,
      body: "Which branch?",
    });
    // Someone else's devices never receive this session's events.
    expect(await pendingFor(other.authSessionId)).toEqual([]);
  });

  test("claims, settles, and forgets a device the provider no longer knows", async () => {
    if (!client) return;
    const person = await personWithAppSession("dispatch");
    await registerNativePushDevice(db(), {
      authSessionId: person.authSessionId,
      platform: "ios",
      appId: "dev.opengeni.app",
      environment: "development",
      token: "e".repeat(64),
      rules: ["agent"],
    });
    const queued = await enqueueNativePush(db(), {
      ...person.scope,
      sessionId: person.session.id,
      rule: "agent",
      dedupeKey: "agent:once",
      title: "Report ready",
      body: "Your weekly report is ready.",
    });
    expect(queued).toBe(1);
    expect(
      await enqueueNativePush(db(), {
        ...person.scope,
        sessionId: person.session.id,
        rule: "agent",
        dedupeKey: "agent:once",
        body: "duplicate",
      }),
    ).toBe(0);
    const claimId = crypto.randomUUID();
    const claimed = (await claimNativePushDeliveries(db(), { claimId, limit: 100 })).filter(
      (row) => row.token === "e".repeat(64),
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.payload).toMatchObject({ title: "Report ready", rule: "agent" });
    await settleNativePushDelivery(db(), {
      claimId,
      deliveryId: claimed[0]!.deliveryId,
      outcome: "delivered",
    });
    expect(await pendingFor(person.authSessionId)).toEqual([]);

    await enqueueNativePush(db(), {
      ...person.scope,
      sessionId: person.session.id,
      rule: "agent",
      dedupeKey: "agent:twice",
      body: "second",
    });
    const second = crypto.randomUUID();
    const [again] = (await claimNativePushDeliveries(db(), { claimId: second })).filter(
      (row) => row.token === "e".repeat(64),
    );
    await settleNativePushDelivery(db(), {
      claimId: second,
      deliveryId: again!.deliveryId,
      outcome: "unregistered",
    });
    expect(await getNativePushDevice(db(), person.authSessionId)).toBeNull();
  });

  test("revoking the app session removes its registration", async () => {
    if (!client) return;
    const person = await personWithAppSession("revoke");
    await registerNativePushDevice(db(), {
      authSessionId: person.authSessionId,
      platform: "ios",
      appId: "dev.opengeni.app",
      environment: "development",
      token: "f".repeat(64),
      rules: ["failed"],
    });
    await owned!.admin`delete from auth_sessions where id = ${person.authSessionId}`;
    const [row] = await owned!.admin<Array<{ count: number }>>`
      select count(*)::int as count from opengeni_private.native_push_devices
      where auth_session_id = ${person.authSessionId}`;
    expect(row?.count).toBe(0);
  });
});
