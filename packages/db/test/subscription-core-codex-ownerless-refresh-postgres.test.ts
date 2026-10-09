import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  persistSubscriptionCodexRefresh,
  refreshSubscriptionCoreCodexCredential,
  withRlsContext,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { rawRows } from "../src/database";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "../src/environment-crypto";
import { withSubscriptionCoreCodexRefreshLock } from "../src/subscription-core-placement-world";
import {
  ownerlessRefreshFixture,
  ownerlessRefreshKey,
  ownerlessRefreshSettings,
} from "./fixtures/ownerless-codex-refresh";

const real = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  if (!real) return;
  const acquired = await acquireSharedTestDatabase("ownerless-person-refresh-0699");
  if (!acquired) throw new Error("Real PostgreSQL required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
  const [role] = await rawRows(
    client.db,
    sql`select current_user as username, rolsuper, rolbypassrls
    from pg_catalog.pg_roles where rolname = current_user`,
  );
  expect(role).toEqual({ username: "opengeni_app", rolsuper: false, rolbypassrls: false });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);
const fixture = (human = true) => ownerlessRefreshFixture({ admin: shared.admin, client }, human);

describe.skipIf(!real)("ownerless shared Codex refresh after 0700", () => {
  for (const human of [false, true]) {
    test(`${human ? "person" : "service"}-initiated ownerless refresh persists once without personal authority`, async () => {
      const state = await fixture(human);
      let callbacks = 0;
      expect(
        await withSubscriptionCoreCodexRefreshLock(
          client.db,
          { ...state.identity, ...state.lease },
          async () => {
            callbacks++;
            return "admitted";
          },
        ),
      ).toEqual({ status: "completed", value: "admitted" });
      expect(callbacks).toBe(1);
      const capabilities =
        await shared.admin`select capability_kind, session_owner_subject_id, turn_human_subject_id
        from opengeni_private.subscription_runtime_capabilities
        where account_id = ${state.accountId}::uuid and capability_kind in ('personal_access', 'codex_refresh_authorized')`;
      expect(capabilities.map((row) => ({ ...row }))).toEqual([
        {
          capability_kind: "codex_refresh_authorized",
          session_owner_subject_id: null,
          turn_human_subject_id: null,
        },
      ]);
      const [before] =
        await shared.admin`select version from subscription_connections where id = ${state.connectionId}::uuid`;
      let providerCalls = 0;
      expect(
        await refreshSubscriptionCoreCodexCredential(
          client.db,
          ownerlessRefreshSettings,
          state.identity,
          state.lease,
          1,
          {
            refresh: async () => {
              providerCalls++;
              return {
                accessToken: "synthetic-renewed",
                refreshToken: "synthetic-renewed-refresh",
              };
            },
          },
        ),
      ).toMatchObject({ kind: "refreshed", refreshGeneration: 2 });
      expect(providerCalls).toBe(1);
      const [after] =
        await shared.admin`select credential_encrypted, version, refresh_generation from subscription_connections
        where id = ${state.connectionId}::uuid`;
      expect(after!.version).toBe(before!.version);
      expect(Number(after!.refresh_generation)).toBe(2);
      expect(
        JSON.parse(decryptEnvironmentValue(ownerlessRefreshKey, after!.credential_encrypted)),
      ).toMatchObject({
        access_token: "synthetic-renewed",
        refresh_token: "synthetic-renewed-refresh",
      });
      expect(
        await refreshSubscriptionCoreCodexCredential(
          client.db,
          ownerlessRefreshSettings,
          state.identity,
          state.lease,
          1,
          {
            refresh: async () => {
              providerCalls++;
              throw new Error("stale token generation reached provider");
            },
          },
        ),
      ).toEqual({ kind: "superseded" });
      expect(providerCalls).toBe(1);
    }, 180_000);
  }

  test("stale lease holder, lease generation, foreign connection and expired lease never call the provider", async () => {
    const state = await fixture();
    const other = await fixture();
    let callbacks = 0;
    for (const lease of [
      { ...state.lease, holderId: "stale-holder" },
      { ...state.lease, generation: state.lease.generation + 1 },
      { ...state.lease, connectionId: other.connectionId },
    ]) {
      expect(
        await withSubscriptionCoreCodexRefreshLock(
          client.db,
          { ...state.identity, ...lease },
          async () => {
            callbacks++;
          },
        ),
      ).toEqual({ status: "lease_lost" });
    }
    await shared.admin`update subscription_leases set leased_until = clock_timestamp() - interval '1 second'
      where account_id = ${state.accountId}::uuid and connection_id = ${state.connectionId}::uuid`;
    expect(
      await refreshSubscriptionCoreCodexCredential(
        client.db,
        ownerlessRefreshSettings,
        state.identity,
        state.lease,
        1,
        {
          refresh: async () => {
            callbacks++;
            throw new Error("expired lease reached provider");
          },
        },
      ),
    ).toEqual({ kind: "lease_lost" });
    expect(callbacks).toBe(0);
  }, 180_000);

  test("forged accepted owner/human identities and disabled cutover never reach the provider", async () => {
    const state = await fixture();
    let callbacks = 0;
    for (const identity of [
      { ...state.identity, sessionOwnerSubjectId: state.subjectId },
      { ...state.identity, initiatingHumanSubjectId: `user:${crypto.randomUUID()}` },
    ]) {
      try {
        const result = await withSubscriptionCoreCodexRefreshLock(
          client.db,
          { ...identity, ...state.lease },
          async () => {
            callbacks++;
          },
        );
        expect(result.status).toBe("not_visible");
      } catch (error) {
        expect(String(error)).toContain(
          "Accepted subscription turn authority does not match its session",
        );
      }
    }
    await shared.admin`update subscription_provider_cutovers set enabled = false where account_id = ${state.accountId}::uuid and provider = 'codex'`;
    expect(
      await refreshSubscriptionCoreCodexCredential(
        client.db,
        ownerlessRefreshSettings,
        state.identity,
        state.lease,
        1,
        {
          refresh: async () => {
            callbacks++;
            throw new Error("disabled cutover reached provider");
          },
        },
      ),
    ).toEqual({ kind: "refused" });
    expect(callbacks).toBe(0);
  }, 180_000);

  test("person presence cannot authorize a people-scoped connection or a non-core caller", async () => {
    const state = await fixture();
    await withSessionRlsActorContext({ subjectId: state.subjectId }, () =>
      withRlsContext(
        client.db,
        {
          accountId: state.accountId,
          workspaceId: state.workspaceId,
        },
        async (tx) => {
          await tx.execute(
            sql`update subscription_connections set scope_kind = 'people' where id = ${state.connectionId}::uuid`,
          );
        },
      ),
    );
    let callbacks = 0;
    expect(
      await withSubscriptionCoreCodexRefreshLock(
        client.db,
        { ...state.identity, ...state.lease },
        async () => {
          callbacks++;
        },
      ),
    ).toEqual({ status: "refused" });
    expect(callbacks).toBe(0);

    const direct = await fixture();
    for (const actor of [
      { subjectId: direct.subjectId, initiatingHumanSubjectId: direct.subjectId },
      { subjectId: "service:subscription-core", initiatingHumanSubjectId: direct.subjectId },
    ]) {
      const rows = await withSessionRlsActorContext(actor, () =>
        withRlsContext(
          client.db,
          {
            accountId: direct.accountId,
            workspaceId: direct.workspaceId,
          },
          (tx) =>
            rawRows(
              tx,
              sql`select * from opengeni_private.begin_subscription_codex_refresh(
        ${direct.accountId}::uuid, ${direct.workspaceId}::uuid, ${direct.identity.sessionId}::uuid,
        ${direct.identity.turnId}::uuid, null, ${direct.subjectId}, ${direct.connectionId}::uuid,
        ${direct.lease.holderId}, ${direct.lease.generation}::bigint)`,
            ),
        ),
      );
      expect(rows).toEqual([]);
    }
  }, 180_000);

  test("persistence still requires a one-shot capability and exact refresh generation", async () => {
    const state = await fixture();
    const write = {
      ...state.identity,
      connectionId: state.connectionId,
      expectedRefreshGeneration: 2,
      credentialEncrypted: encryptEnvironmentValue(ownerlessRefreshKey, "synthetic-CAS-refusal"),
      expiresAt: null,
      lastRefreshAt: new Date(),
    };
    expect(
      await withSubscriptionCoreCodexRefreshLock(
        client.db,
        { ...state.identity, ...state.lease },
        async (tx) => {
          expect(await persistSubscriptionCodexRefresh(tx, write)).toBe(false);
          // A refused CAS consumes the authorization; it cannot be reused with a
          // newly guessed generation inside this transaction.
          return await persistSubscriptionCodexRefresh(tx, {
            ...write,
            expectedRefreshGeneration: 1,
          });
        },
      ),
    ).toEqual({ status: "completed", value: false });
    expect(
      await withSessionRlsActorContext(
        { subjectId: "service:subscription-core", initiatingHumanSubjectId: null },
        () =>
          withRlsContext(
            client.db,
            { accountId: state.accountId, workspaceId: state.workspaceId },
            (tx) => persistSubscriptionCodexRefresh(tx, { ...write, expectedRefreshGeneration: 1 }),
          ),
      ),
    ).toBe(false);
    const [unchanged] =
      await shared.admin`select refresh_generation from subscription_connections where id = ${state.connectionId}::uuid`;
    expect(Number(unchanged!.refresh_generation)).toBe(1);
  }, 180_000);
});
