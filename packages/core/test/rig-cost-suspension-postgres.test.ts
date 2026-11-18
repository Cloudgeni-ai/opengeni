import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AccessGrant, Rig } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { bootstrapWorkspace, createDb, resetOrganizationSuspensionCache } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { createRigForApi, createRigVersionForApi, proposeRigChangeForApi } from "../src/rigs";

// A new sandbox environment, change or version starts a verification sandbox:
// a suspended organization (Free, never paid, denied while promotion
// enforcement is on) is refused with 403 before anything is written. Paid
// organizations are never suspended.

let shared: SharedTestDatabase | null;
let client: ReturnType<typeof createDb> | undefined;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-rig-cost-suspension");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("PostgreSQL required");
  }
  if (!shared) return;
  client = createDb(shared.appUrl);
  await shared.admin`insert into promotion_enforcement (singleton, enabled) values (true, true)
    on conflict (singleton) do update set enabled = excluded.enabled`;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function organization(options: { plan: string; decision?: "denied" }): Promise<AccessGrant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client!.db, {
    // A self-serve source: any other external source is host-provisioned
    // (embedded) and never suspended.
    accountExternalSource: "opengeni:additional-organization",
    accountExternalId: `rig-cost-${suffix}`,
    accountName: "Rig cost",
    workspaceExternalSource: "test",
    workspaceExternalId: `rig-cost-${suffix}`,
    workspaceName: "Rig cost",
    subjectId: `user:rig-cost-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  await shared!.admin`insert into organization_plans (account_id, plan_key, status)
    values (${grant.accountId}, ${options.plan}, 'active')
    on conflict (account_id) do update set plan_key = excluded.plan_key, status = excluded.status`;
  if (options.decision) {
    await shared!.admin`insert into promotion_decisions (account_id, decision, revision, actor)
      values (${grant.accountId}, ${options.decision}, 1, 'test')
      on conflict (account_id) do update set decision = excluded.decision`;
  }
  resetOrganizationSuspensionCache();
  return grant;
}

async function status(attempt: Promise<unknown>): Promise<number | "ok"> {
  try {
    await attempt;
    return "ok";
  } catch (error) {
    if (error instanceof HTTPException) return error.status;
    throw error;
  }
}

function rigFor(grant: AccessGrant): Rig {
  return {
    id: crypto.randomUUID(),
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    activeVersion: { id: crypto.randomUUID(), setupScript: null, checks: [], credentialHooks: [] },
  } as unknown as Rig;
}

test("a suspended organization cannot create a sandbox environment, change or version", async () => {
  if (!client) return;
  const grant = await organization({ plan: "free", decision: "denied" });
  const deps = { db: client.db };
  expect(
    await status(
      createRigForApi(deps, grant, {
        scope: "workspace",
        name: "env",
        checks: [],
        credentialHooks: [],
      }),
    ),
  ).toBe(403);
  expect(
    await status(
      proposeRigChangeForApi(deps, grant, rigFor(grant), {
        kind: "setup_append",
        payload: { command: "echo hi" },
      } as never),
    ),
  ).toBe(403);
  expect(
    await status(createRigVersionForApi(deps, grant, rigFor(grant), { checks: [] } as never)),
  ).toBe(403);
  const [rows] = await shared!.admin<{ count: number }[]>`select count(*)::int as count from rigs
    where account_id = ${grant.accountId}`;
  expect(rows!.count).toBe(0);
}, 60_000);

test("a paid organization with the same decision is not suspended", async () => {
  if (!client) return;
  const grant = await organization({ plan: "pro", decision: "denied" });
  const rig = await createRigForApi({ db: client.db }, grant, {
    scope: "workspace",
    name: "env",
    checks: [],
    credentialHooks: [],
  });
  expect(rig.accountId).toBe(grant.accountId);
}, 60_000);
