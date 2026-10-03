import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createOrganizationApiKey } from "@opengeni/db";
import { requireAccessContext } from "../src/access";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  rawRows,
  withAccountRls,
  withSessionRlsActorContext,
  type DbClient,
} from "../../db/src/database";
import {
  ensureExternalIdentity,
  lockExternalWorkspaceMembershipLifecycle,
} from "../../db/src/external-identities";
import { assertActiveManagedHumanOrganizationMembership } from "../../db/src/organization-membership-lifecycle";
import { nestedPostgresSqlState } from "../../db/src/persistence-errors";

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("external-identity-lock-order");
  if (!acquired) throw new Error("External identity lock-order checks require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("external identity lookup uses a non-owner role without RLS bypass", async () => {
  const [posture] = await rawRows<{
    superuser: boolean;
    bypassRls: boolean;
    ownsMemberships: boolean;
    forcedRls: boolean;
  }>(
    client.db,
    sql`select role.rolsuper as superuser, role.rolbypassrls as "bypassRls",
      relation.relowner = role.oid as "ownsMemberships",
      relation.relforcerowsecurity as "forcedRls"
      from pg_roles role, pg_class relation
      where role.rolname = current_user
        and relation.oid = 'organization_memberships'::regclass`,
  );
  expect(posture).toEqual({
    superuser: false,
    bypassRls: false,
    ownsMemberships: false,
    forcedRls: true,
  });
});

test("concurrent identity lookup cannot invert a membership-fenced writer", async () => {
  const [account] = await shared.admin`
    insert into managed_accounts (name) values ('External identity concurrency') returning id`;
  if (!account) throw new Error("Account fixture missing");
  const input = {
    accountId: String(account.id),
    source: "example.test",
    externalId: crypto.randomUUID(),
  };
  const identity = await ensureExternalIdentity(client.db, input);
  const token = crypto.randomUUID();
  await createOrganizationApiKey(client.db, {
    accountId: input.accountId,
    name: "External request fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:read"],
  });
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  app.get("/context", async (c) =>
    c.json(
      await requireAccessContext(c, {
        db: client.db,
        settings: testSettings({ productAccessMode: "configured" }),
      }),
    ),
  );
  const lookup = () =>
    app.request("http://example.test/context", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({
            mode: "external",
            identity: { source: input.source, externalId: input.externalId },
          }),
        ),
      },
    });
  const writerReady = Promise.withResolvers<number>();
  const continueWriter = Promise.withResolvers<void>();
  const writer = withSessionRlsActorContext({ subjectId: identity.subjectId }, () =>
    withAccountRls(client.db, input.accountId, async (tx) => {
      await lockExternalWorkspaceMembershipLifecycle(tx, input.accountId);
      const revision = await assertActiveManagedHumanOrganizationMembership(tx, {
        accountId: input.accountId,
        subjectId: identity.subjectId,
      });
      expect(revision).toBe(1);
      const [backend] = await rawRows<{ pid: number }>(tx, sql`select pg_backend_pid() as pid`);
      if (!backend) throw new Error("Writer backend missing");
      writerReady.resolve(backend.pid);
      await continueWriter.promise;
      // A private session writer rechecks the identity after locking its live
      // membership. The organization fence must be reentrant on this backend.
      return await ensureExternalIdentity(tx, input);
    }),
  ).then(
    (value) => ({ value, code: null }),
    (error) => {
      writerReady.reject(error);
      return { value: null, code: nestedPostgresSqlState(error) ?? String(error) };
    },
  );
  let reader: Promise<Response> | undefined;
  let waitingLock: string | undefined;
  try {
    const writerPid = await writerReady.promise;
    reader = lookup();
    const deadline = Date.now() + 5_000;
    do {
      const [waiting] = await shared.admin<{ locktype: string }[]>`
        select lock.locktype from pg_locks lock
        join pg_stat_activity activity on activity.pid = lock.pid
        where activity.datname = current_database() and lock.pid <> ${writerPid}
          and not lock.granted
          and ${writerPid} = any(pg_blocking_pids(lock.pid))`;
      if (waiting) {
        waitingLock = waiting.locktype;
        break;
      }
      await Bun.sleep(10);
    } while (Date.now() < deadline);
    if (!waitingLock) throw new Error("Concurrent identity lookup did not reach its lock barrier");
    continueWriter.resolve();
    const [writeResult, readResponse] = await Promise.all([writer, reader]);
    expect(writeResult.code).toBeNull();
    expect(writeResult.value?.id).toBe(identity.id);
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({ subjectId: identity.subjectId });
    expect(waitingLock).toBe("advisory");
  } finally {
    continueWriter.resolve();
    await Promise.all([writer, ...(reader ? [reader] : [])]);
  }
}, 30_000);
