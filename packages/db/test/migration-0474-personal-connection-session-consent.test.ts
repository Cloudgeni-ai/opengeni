import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  createSession,
  createConnection,
  issueSelfUserResourceGrant,
  listSelfUserResourceAuthorities,
  revokeSelfUserResourceGrant,
  transitionSessionVisibility,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0474-connection-consent");
  if (!owned) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const url = new URL(owned.ownerUrl);
  url.username = "opengeni_app";
  url.password = owned.appPassword;
  client = createDb(url.toString(), { max: 4, rlsStrategy: "force" });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await owned?.release();
}, 180_000);

async function expectActivationDenied(operation: Promise<unknown>): Promise<void> {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  while (failure instanceof Error && failure.cause instanceof Error) failure = failure.cause;
  expect((failure as Error).message).toContain("session tenancy product is not activated");
}

test("preactivation consent retains owner, private-session, workspace, epoch and resource-kind fences under FORCE RLS", async () => {
  if (!owned || !client) return;
  const { admin } = owned;
  const db = client.db;
  const [role] =
    await admin`select rolsuper, rolbypassrls from pg_roles where rolname = ${owned.ownerRole}`;
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  const routines = await admin`
    select p.proname, r.rolname as owner, p.prosecdef,
      exists (select 1 from aclexplode(p.proacl) acl where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute
    from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.oid in (
      'list_self_user_resource_authorities(uuid,uuid,text,uuid,integer)'::regprocedure,
      'issue_self_user_resource_grant(uuid,uuid,uuid,text,text,text,uuid,integer,boolean)'::regprocedure,
      'revoke_self_user_resource_grant(uuid,uuid,uuid)'::regprocedure)`;
  expect(routines).toHaveLength(3);
  for (const routine of routines)
    expect(routine).toMatchObject({
      owner: owned.ownerRole,
      prosecdef: true,
      public_execute: false,
    });
  const forced =
    await admin`select relforcerowsecurity from pg_class where oid in ('sessions'::regclass, 'organization_user_resource_authorities'::regclass, 'organization_user_resource_grants'::regclass)`;
  expect(forced).toHaveLength(3);
  for (const row of forced) expect(row.relforcerowsecurity).toBe(true);
  const [acl] =
    await admin`select has_table_privilege('opengeni_app', 'organization_user_resource_grants', 'INSERT') as insert_grant`;
  expect(acl!.insert_grant).toBe(false);

  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const personalWorkspaceId = crypto.randomUUID();
  const strangerPersonalId = crypto.randomUUID();
  const subjectId = `user:${crypto.randomUUID()}`;
  const stranger = `user:${crypto.randomUUID()}`;
  await admin`insert into managed_accounts (id, name) values (${accountId}, 'connection consent fixture')`;
  for (const id of [workspaceId, personalWorkspaceId, strangerPersonalId]) {
    await admin`insert into workspaces (id, account_id, name) values (${id}, ${accountId}, 'consent workspace')`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${id}, ${accountId})`;
  }
  for (const [subject, personalId] of [
    [subjectId, personalWorkspaceId],
    [stranger, strangerPersonalId],
  ] as const) {
    await admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
      values (${accountId}, ${subject}, 'active', ${personalId})`;
    await admin`insert into workspace_memberships (account_id, workspace_id, subject_id, permissions)
      values (${accountId}, ${workspaceId}, ${subject}, '["sessions:create","sessions:read","sessions:control","connections:read"]'::jsonb)`;
  }
  const connection = await createConnection(db, {
    accountId,
    workspaceId: personalWorkspaceId,
    subjectId,
    providerDomain: "gmailmcp.googleapis.com",
    kind: "oauth2",
    credentialEncrypted: "fixture-only",
  });
  const strangerConnection = await createConnection(db, {
    accountId,
    workspaceId,
    subjectId: stranger,
    providerDomain: "gmailmcp.googleapis.com",
    kind: "oauth2",
    credentialEncrypted: "fixture-only",
  });
  expect(connection.authorityId).toBeString();
  const seed = (targetWorkspaceId: string) =>
    withSessionRlsActorContext({ subjectId }, () =>
      createSession(db, {
        accountId,
        workspaceId: targetWorkspaceId,
        subjectId,
        createdBy: { kind: "subject", subjectId },
        initialMessage: "",
        resources: [],
        metadata: {},
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      }),
    );
  const session = await seed(workspaceId);
  const personalSession = await seed(personalWorkspaceId);
  const issue = (overrides: Partial<Parameters<typeof issueSelfUserResourceGrant>[1]> = {}) =>
    issueSelfUserResourceGrant(db, {
      accountId,
      workspaceId,
      subjectId,
      authorityId: connection.authorityId!,
      resourceKind: "connection",
      mode: "session",
      context: "workspace_shared",
      sessionId: session.id,
      expectedAuthorityEpoch: 1,
      workspaceSharedAcknowledged: true,
      ...overrides,
    });
  const listed = await listSelfUserResourceAuthorities(db, {
    accountId,
    workspaceId,
    subjectId,
    resourceKind: "connection",
    limit: 50,
  });
  expect(listed.authorities.map((a) => a.authorityId)).toEqual([connection.authorityId!]);
  const grant = await issue();
  expect(grant.status).toBe("active");
  expect((await issue()).grantId).toBe(grant.grantId);
  expect(
    (await issue({ workspaceId: personalWorkspaceId, sessionId: personalSession.id })).status,
  ).toBe("active");
  await expect(issue({ expectedAuthorityEpoch: 2 })).rejects.toThrow();
  await expect(issue({ workspaceSharedAcknowledged: false })).rejects.toThrow();
  await expect(issue({ context: "user_private" })).rejects.toThrow();
  await expect(issue({ subjectId: stranger })).rejects.toThrow();
  await expect(issue({ workspaceId: strangerPersonalId })).rejects.toThrow();
  await expectActivationDenied(
    issue({ mode: "always", sessionId: null, expectedAuthorityEpoch: null }),
  );
  for (const resourceKind of ["variable_set", "rig", "document", "connected_machine"] as const) {
    await expectActivationDenied(issue({ resourceKind }));
    await expectActivationDenied(
      listSelfUserResourceAuthorities(db, {
        accountId,
        workspaceId,
        subjectId,
        resourceKind,
        limit: 50,
      }),
    );
  }
  await expect(
    revokeSelfUserResourceGrant(db, {
      accountId,
      workspaceId,
      subjectId: stranger,
      grantId: grant.grantId,
    }),
  ).rejects.toThrow();
  const revoked = await revokeSelfUserResourceGrant(db, {
    accountId,
    workspaceId,
    subjectId,
    grantId: grant.grantId,
  });
  expect(revoked.status).toBe("revoked");
  expect(
    (
      await revokeSelfUserResourceGrant(db, {
        accountId,
        workspaceId,
        subjectId,
        grantId: grant.grantId,
      })
    ).generation,
  ).toBe(revoked.generation);

  // Create actual private state through its existing capability seam, then remove
  // only the fixture receipt: consent must still enforce stored private ownership
  // even when the API's separately activated tenancy projection is absent.
  await admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'fixture')`;
  await admin`insert into organization_private_session_settings (account_id, enabled, version) values (${accountId}, true, 1)`;
  await transitionSessionVisibility(db, {
    workspaceId,
    sessionId: session.id,
    actorSubjectId: subjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: crypto.randomUUID(),
  });
  await admin`delete from session_tenancy_activations where account_id = ${accountId}`;
  const [membership] =
    await admin`select id from organization_memberships where account_id = ${accountId} and subject_id = ${subjectId}`;
  const otherAuthority = crypto.randomUUID();
  const otherGrant = crypto.randomUUID();
  await admin`insert into organization_user_resource_authorities (
    id, account_id, organization_membership_id, resource_kind, resource_id, origin_workspace_id
  ) values (${otherAuthority}, ${accountId}, ${membership!.id}, 'rig', ${crypto.randomUUID()}, ${personalWorkspaceId})`;
  await admin`insert into organization_user_resource_grants (
    id, account_id, authority_id, owner_organization_membership_id, workspace_id, action, mode, context, generation, status
  ) values (${otherGrant}, ${accountId}, ${otherAuthority}, ${membership!.id}, ${workspaceId}, 'rig.use', 'always', 'user_private', 1, 'active')`;
  await expectActivationDenied(
    revokeSelfUserResourceGrant(db, { accountId, workspaceId, subjectId, grantId: otherGrant }),
  );
  const privateGrant = await issue({
    context: "user_private",
    expectedAuthorityEpoch: 2,
    workspaceSharedAcknowledged: false,
  });
  expect(privateGrant.status).toBe("active");
  await expect(
    issue({
      subjectId: stranger,
      authorityId: strangerConnection.authorityId!,
      context: "user_private",
      expectedAuthorityEpoch: 2,
    }),
  ).rejects.toThrow();
  // Loss of the owning membership removes both discovery and issuance.
  await admin`update organization_memberships set status = 'revoked', revoked_at = clock_timestamp()
    where account_id = ${accountId} and subject_id = ${subjectId}`;
  await expect(issue({ context: "user_private", expectedAuthorityEpoch: 2 })).rejects.toThrow();
  await expect(
    listSelfUserResourceAuthorities(db, {
      accountId,
      workspaceId,
      subjectId,
      resourceKind: "connection",
      limit: 50,
    }),
  ).rejects.toThrow();
}, 180_000);
