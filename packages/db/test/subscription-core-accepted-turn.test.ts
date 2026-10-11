import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  assertSubscriptionCoreAcceptedTurn,
  withSubscriptionCoreAcceptedTurn,
  type SubscriptionCoreAcceptedTurnIdentity,
} from "../src/subscription-core-placement-world";
import { withSubscriptionCoreCodexRefreshLock } from "../src/subscription-core-codex-bindings";
import type { Database } from "../src/database";
import * as database from "../src/database";

const identity: SubscriptionCoreAcceptedTurnIdentity = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  sessionOwnerSubjectId: "user:owner",
  sessionOwnerMembershipId: "55555555-5555-4555-8555-555555555555",
  initiatingHumanSubjectId: "user:owner",
};

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

function transaction(results: Array<Array<Record<string, unknown>>>) {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  const dialect = new PgDialect();
  const db = {
    execute: async (statement: Parameters<Database["execute"]>[0]) => {
      const query = dialect.sqlToQuery(statement as SQL);
      statements.push(query.sql);
      parameters.push(query.params);
      return results.shift() ?? [];
    },
  } as unknown as Database;
  return { db, statements, parameters };
}

describe("subscription-core accepted-turn guard", () => {
  test("checks the database capability and exact immutable owner tuple", async () => {
    const { db, statements } = transaction([
      [{ authorized: true }],
      [
        {
          owner_subject_id: identity.sessionOwnerSubjectId,
          owner_membership_id: identity.sessionOwnerMembershipId,
          initiating_human_subject_id: identity.initiatingHumanSubjectId,
          visibility: "shared",
        },
      ],
    ]);

    await expect(assertSubscriptionCoreAcceptedTurn(db, identity)).resolves.toBe(true);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("authorize_subscription_session_access");
    expect(statements[1]).toContain("from sessions");
  });

  test("stops before reading session identity when the database capability denies access", async () => {
    const { db, statements } = transaction([[{ authorized: false }]]);

    await expect(assertSubscriptionCoreAcceptedTurn(db, identity)).resolves.toBe(false);
    expect(statements).toHaveLength(1);
  });

  test("rejects a caller tuple that differs from the accepted turn", async () => {
    const { db } = transaction([
      [{ authorized: true }],
      [
        {
          owner_subject_id: identity.sessionOwnerSubjectId,
          owner_membership_id: "66666666-6666-4666-8666-666666666666",
          initiating_human_subject_id: identity.initiatingHumanSubjectId,
          visibility: "shared",
        },
      ],
    ]);

    await expect(assertSubscriptionCoreAcceptedTurn(db, identity)).rejects.toThrow(
      "Accepted subscription turn authority does not match its session",
    );
  });

  test("rejects private sessions with no owner even if the service capability returns true", async () => {
    const { db } = transaction([
      [{ authorized: true }],
      [
        {
          owner_subject_id: null,
          owner_membership_id: null,
          initiating_human_subject_id: null,
          visibility: "user_private",
        },
      ],
    ]);

    await expect(
      assertSubscriptionCoreAcceptedTurn(db, {
        ...identity,
        sessionOwnerSubjectId: null,
        sessionOwnerMembershipId: null,
        initiatingHumanSubjectId: null,
      }),
    ).rejects.toThrow("An ownerless subscription session cannot be private");
  });

  test("runs only inside the service actor and exact account/workspace RLS transaction", async () => {
    const { db } = transaction([
      [{ authorized: true }],
      [
        {
          owner_subject_id: identity.sessionOwnerSubjectId,
          owner_membership_id: identity.sessionOwnerMembershipId,
          initiating_human_subject_id: identity.initiatingHumanSubjectId,
          visibility: "shared",
        },
      ],
    ]);
    let actor: unknown;
    let scope: unknown;
    const sessionActor = spyOn(database, "withSessionRlsActorContext").mockImplementation(
      async (value, run) => {
        actor = value;
        return await run();
      },
    );
    const rls = spyOn(database, "withRlsContext").mockImplementation(async (_db, value, run) => {
      scope = value;
      return await run(db);
    });
    restores.push(
      () => sessionActor.mockRestore(),
      () => rls.mockRestore(),
    );

    await expect(
      withSubscriptionCoreAcceptedTurn(db, identity, async (tx) => {
        expect(tx).toBe(db);
        return "authorized result";
      }),
    ).resolves.toEqual({ status: "completed", value: "authorized result" });
    expect(actor).toEqual({
      subjectId: "service:subscription-core",
      initiatingHumanSubjectId: identity.initiatingHumanSubjectId,
    });
    expect(scope).toEqual({ accountId: identity.accountId, workspaceId: identity.workspaceId });
  });

  test("serializes refresh only while the exact Codex lease is live", async () => {
    const connectionId = "66666666-6666-4666-8666-666666666666";
    const holderId = "worker:turn-holder";
    const { db, statements, parameters } = transaction([
      [{ authorized: true }],
      [
        {
          owner_subject_id: identity.sessionOwnerSubjectId,
          owner_membership_id: identity.sessionOwnerMembershipId,
          initiating_human_subject_id: identity.initiatingHumanSubjectId,
          visibility: "shared",
        },
      ],
      [{ current: true }],
      [],
      [],
      [{ current: true }],
      [{ refresh_generation: "4", credential_encrypted: "v1:current", expires_at: null }],
    ]);
    const sessionActor = spyOn(database, "withSessionRlsActorContext").mockImplementation(
      async (_value, run) => await run(),
    );
    const rls = spyOn(database, "withRlsContext").mockImplementation(
      async (_db, _value, run) => await run(db),
    );
    restores.push(
      () => sessionActor.mockRestore(),
      () => rls.mockRestore(),
    );
    let operationCalls = 0;
    let received: unknown;

    await expect(
      withSubscriptionCoreCodexRefreshLock(
        db,
        { ...identity, connectionId, holderId, generation: 7 },
        async (_tx, credential) => {
          operationCalls += 1;
          received = credential;
          return "refreshed";
        },
      ),
    ).resolves.toEqual({ status: "completed", value: "refreshed" });
    expect(operationCalls).toBe(1);
    expect(received).toEqual({
      refreshGeneration: 4,
      credentialEncrypted: "v1:current",
      expiresAt: null,
    });
    expect(
      statements.some((statement) => statement.includes("begin_subscription_core_refresh")),
    ).toBe(true);
    expect(statements.some((statement) => statement.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(
      statements.filter((statement) => statement.includes("subscription_leases")),
    ).toHaveLength(2);
    expect(parameters.flat()).toContain(`subscription-refresh:${connectionId}`);
  });

  test("does not enter the refresh callback when the database refuses refresh authorization", async () => {
    const { db } = transaction([
      [{ authorized: true }],
      [
        {
          owner_subject_id: identity.sessionOwnerSubjectId,
          owner_membership_id: identity.sessionOwnerMembershipId,
          initiating_human_subject_id: identity.initiatingHumanSubjectId,
          visibility: "shared",
        },
      ],
      [{ current: true }],
      [],
      [],
      [{ current: true }],
      [],
    ]);
    const sessionActor = spyOn(database, "withSessionRlsActorContext").mockImplementation(
      async (_value, run) => await run(),
    );
    const rls = spyOn(database, "withRlsContext").mockImplementation(
      async (_db, _value, run) => await run(db),
    );
    restores.push(
      () => sessionActor.mockRestore(),
      () => rls.mockRestore(),
    );
    let operationCalls = 0;

    await expect(
      withSubscriptionCoreCodexRefreshLock(
        db,
        {
          ...identity,
          connectionId: "66666666-6666-4666-8666-666666666666",
          holderId: "worker:refused",
          generation: 3,
        },
        async () => {
          operationCalls += 1;
          return "must not refresh";
        },
      ),
    ).resolves.toEqual({ status: "refused" });
    expect(operationCalls).toBe(0);
  });

  test("rechecks the lease after waiting for the refresh lock", async () => {
    const connectionId = "66666666-6666-4666-8666-666666666666";
    const { db, statements } = transaction([
      [{ authorized: true }],
      [
        {
          owner_subject_id: identity.sessionOwnerSubjectId,
          owner_membership_id: identity.sessionOwnerMembershipId,
          initiating_human_subject_id: identity.initiatingHumanSubjectId,
          visibility: "shared",
        },
      ],
      [{ current: true }],
      [],
      [],
      [{ current: false }],
    ]);
    const sessionActor = spyOn(database, "withSessionRlsActorContext").mockImplementation(
      async (_value, run) => await run(),
    );
    const rls = spyOn(database, "withRlsContext").mockImplementation(
      async (_db, _value, run) => await run(db),
    );
    restores.push(
      () => sessionActor.mockRestore(),
      () => rls.mockRestore(),
    );
    let operationCalls = 0;

    await expect(
      withSubscriptionCoreCodexRefreshLock(
        db,
        { ...identity, connectionId, holderId: "expired-during-lock", generation: 9 },
        async () => {
          operationCalls += 1;
          return "must not refresh";
        },
      ),
    ).resolves.toEqual({ status: "lease_lost" });
    expect(operationCalls).toBe(0);
    expect(statements.some((statement) => statement.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(
      statements.filter((statement) => statement.includes("subscription_leases")),
    ).toHaveLength(2);
  });

  test("does not enter the refresh callback when the lease generation is no longer current", async () => {
    const { db, statements } = transaction([
      [{ authorized: true }],
      [
        {
          owner_subject_id: identity.sessionOwnerSubjectId,
          owner_membership_id: identity.sessionOwnerMembershipId,
          initiating_human_subject_id: identity.initiatingHumanSubjectId,
          visibility: "shared",
        },
      ],
      [{ current: false }],
    ]);
    const sessionActor = spyOn(database, "withSessionRlsActorContext").mockImplementation(
      async (_value, run) => await run(),
    );
    const rls = spyOn(database, "withRlsContext").mockImplementation(
      async (_db, _value, run) => await run(db),
    );
    restores.push(
      () => sessionActor.mockRestore(),
      () => rls.mockRestore(),
    );
    let operationCalls = 0;

    await expect(
      withSubscriptionCoreCodexRefreshLock(
        db,
        {
          ...identity,
          connectionId: "66666666-6666-4666-8666-666666666666",
          holderId: "lost",
          generation: 8,
        },
        async () => {
          operationCalls += 1;
          return "should not run";
        },
      ),
    ).resolves.toEqual({ status: "lease_lost" });
    expect(operationCalls).toBe(0);
    expect(statements.some((statement) => statement.includes("pg_advisory_xact_lock"))).toBe(false);
  });
});
