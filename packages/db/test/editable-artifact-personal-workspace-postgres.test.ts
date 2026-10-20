import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import { createDb, managedPersonalWorkspacePermissions, withRlsContext } from "../src/index";
import { rawRows } from "../src/database";

// The owner of a personal workspace creates, opens and edits documents,
// spreadsheets and presentations there (0869). A personal workspace has no
// workspace_memberships row; its owner's authority is the active organization
// membership's personal workspace pointer. Run as the restricted application
// role in the deployed posture, with a NOBYPASSRLS and a BYPASSRLS owner.

let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("editable-personal-workspace");
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function inPosture<T>(bypass: boolean, fn: () => Promise<T>): Promise<T> {
  if (!bypass) return await fn();
  const owner = `"${shared.ownerRole.replaceAll('"', '""')}"`;
  await shared.admin.unsafe(`ALTER ROLE ${owner} BYPASSRLS`);
  try {
    return await fn();
  } finally {
    await shared.admin.unsafe(`ALTER ROLE ${owner} NOBYPASSRLS`);
  }
}

async function organization() {
  const accountId = crypto.randomUUID();
  const personal = crypto.randomUUID();
  const team = crypto.randomUUID();
  const owner = `user:${crypto.randomUUID()}`;
  const colleague = `user:${crypto.randomUUID()}`;
  const colleaguePersonal = crypto.randomUUID();
  await shared.admin`insert into managed_accounts(id,name) values(${accountId},'Editable personal')`;
  for (const id of [personal, team, colleaguePersonal])
    await shared.admin`insert into workspaces(id,account_id,name) values(${id},${accountId},'Workspace')`;
  await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
    values(${accountId},${owner},'owner','active',${personal}),
      (${accountId},${colleague},'member','active',${colleaguePersonal})`;
  await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,role,permissions)
    values(${accountId},${team},${colleague},'viewer',
      opengeni_private.workspace_member_role_permissions('viewer'))`;
  return { accountId, personal, team, owner, colleague };
}

async function allowed(
  accountId: string,
  workspaceId: string,
  subjectId: string,
  permission: "create" | "read" | "edit",
  options: { actorKind?: string; serviceName?: string | undefined; priorLifecycle?: string } = {},
): Promise<boolean> {
  const artifactId = crypto.randomUUID().replaceAll("-", "");
  const [row] = await withRlsContext(app.db, { accountId, workspaceId }, async (tx) => {
    if (options.priorLifecycle)
      await tx.execute(
        sql`select set_config('opengeni.organization_tenancy_lifecycle', ${options.priorLifecycle}, true)`,
      );
    return await rawRows<{ allowed: boolean; lifecycle: string | null }>(
      tx,
      sql`select allowed,
        current_setting('opengeni.organization_tenancy_lifecycle', true) as lifecycle from opengeni_private.authorize_editable_artifact_actor(
        ${accountId}::uuid, ${workspaceId}::uuid, ${artifactId}, ${options.actorKind ?? "human"}, ${subjectId},
        null, null, null, null, ${options.serviceName ?? null}, ${permission}, current_schema())`,
    );
  });
  // The lifecycle scope the read used never outlives it: the caller's own
  // value comes back unchanged.
  expect(row?.lifecycle ?? "").toBe(options.priorLifecycle ?? "");
  return row?.allowed === true;
}

test("the personal workspace projection holds what 0869 grants without checking the permission", () => {
  expect(managedPersonalWorkspacePermissions).toContain("artifacts:read");
  expect(managedPersonalWorkspacePermissions).toContain("artifacts:publish");
});

for (const bypass of [false, true]) {
  test(`a personal workspace's owner holds every editable artifact permission there (${bypass ? "BYPASSRLS" : "restricted"} owner)`, async () => {
    const org = await organization();
    await inPosture(bypass, async () => {
      for (const permission of ["create", "read", "edit"] as const)
        expect({
          permission,
          allowed: await allowed(org.accountId, org.personal, org.owner, permission),
        }).toEqual({ permission, allowed: true });
      // Nobody else reaches it: a colleague in the same organization is refused.
      expect(await allowed(org.accountId, org.personal, org.colleague, "read")).toBe(false);
      // The pointer is the owner's own personal workspace only.
      expect(await allowed(org.accountId, org.team, org.owner, "read")).toBe(false);
      // Memberships are unchanged: a Viewer reads but does not edit.
      expect(await allowed(org.accountId, org.team, org.colleague, "read")).toBe(true);
      expect(await allowed(org.accountId, org.team, org.colleague, "edit")).toBe(false);
      // Only the human branch reaches the pointer: a service, configured key
      // or agent naming the owner's subject is not the owner (refused, or
      // rejected as an invalid actor).
      for (const [actorKind, serviceName] of [
        ["service", "configured_key"],
        ["service", "site"],
        ["agent", undefined],
        ["agent_attempt", undefined],
      ] as const)
        expect({
          actorKind,
          serviceName,
          allowed: await allowed(org.accountId, org.personal, org.owner, "read", {
            actorKind,
            serviceName,
          }).catch(() => false),
        }).toEqual({ actorKind, serviceName, allowed: false });
      // A lifecycle the caller had already set is restored, not cleared.
      expect(
        await allowed(org.accountId, org.personal, org.owner, "edit", {
          priorLifecycle: "session_visibility_activation",
        }),
      ).toBe(true);
    });
    // A suspended owner loses it at once.
    await shared.admin`update organization_memberships set status='suspended'
      where account_id=${org.accountId} and subject_id=${org.owner}`;
    await inPosture(bypass, async () => {
      expect(await allowed(org.accountId, org.personal, org.owner, "read")).toBe(false);
    });
    // So does a revoked one.
    await shared.admin`update organization_memberships set status='revoked', revoked_at=now()
      where account_id=${org.accountId} and subject_id=${org.owner}`;
    await inPosture(bypass, async () => {
      expect(await allowed(org.accountId, org.personal, org.owner, "read")).toBe(false);
    });
  }, 120_000);
}
