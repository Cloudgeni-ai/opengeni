import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

import { deleteDensityProfileAccount } from "../../../scripts/operator/turn-density-profile";
import { bootstrapWorkspace, createDb, createSession } from "../src/index";

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb> | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("turn-density-cleanup");
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("turn-density profile account cleanup", () => {
  test("holds the workspace fence before its account cascade as the non-bypass app role", async () => {
    if (!shared || !client) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "turn-density-cleanup-test",
      accountExternalId: `account-${suffix}`,
      accountName: "Turn density cleanup",
      workspaceExternalSource: "turn-density-cleanup-test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Turn density cleanup",
      subjectId: `operator:turn-density-cleanup:${suffix}`,
    });
    const grant = access.workspaceGrants[0];
    if (!grant?.workspaceId) throw new Error("Workspace bootstrap returned no grant");
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "exercise the managed-account session cascade",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const [posture] = await shared.admin<
      Array<{ bypassRls: boolean; forceRls: boolean; roleName: string }>
    >`
      select role.rolbypassrls as "bypassRls",
             class.relforcerowsecurity as "forceRls",
             role.rolname as "roleName"
      from pg_roles role
      cross join pg_class class
      where role.rolname = 'opengeni_app'
        and class.oid = 'sessions'::regclass
    `;
    expect(posture).toEqual({
      bypassRls: false,
      forceRls: true,
      roleName: "opengeni_app",
    });

    const lockHolder = await shared.admin.reserve();
    let deletionSettled = false;
    let lockTransactionOpen = false;
    try {
      await lockHolder`begin`;
      lockTransactionOpen = true;
      await lockHolder`
        select pg_advisory_xact_lock(hashtextextended(
          ${`session-tenancy:${grant.workspaceId}`}, 0
        ))
      `;
      const deletion = deleteDensityProfileAccount(
        client.db,
        grant.accountId,
        grant.workspaceId,
      ).finally(() => {
        deletionSettled = true;
      });
      await Bun.sleep(250);
      expect(deletionSettled).toBe(false);
      await lockHolder`rollback`;
      lockTransactionOpen = false;
      await deletion;
    } finally {
      if (lockTransactionOpen) await lockHolder`rollback`.catch(() => undefined);
      lockHolder.release();
    }

    const [remaining] = await shared.admin<Array<{ accounts: number; sessions: number }>>`
      select
        (select count(*)::int from managed_accounts where id = ${grant.accountId}) as accounts,
        (select count(*)::int from sessions where id = ${session.id}) as sessions
    `;
    expect(remaining).toEqual({ accounts: 0, sessions: 0 });
  }, 120_000);
});
