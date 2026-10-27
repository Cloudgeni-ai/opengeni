import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";

import {
  acceptOrganizationInvitation,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getOrganizationInferenceResidency,
  InferenceResidencyChangeRefusedError,
  type InferenceResidencyActorKind,
  isWorkspaceEuOnly,
  nestedPostgresSqlState,
  updateOrganizationInferenceResidency,
  updateOrganizationMember,
  WorkspaceInferenceResidencyUnknownError,
} from "../src/index";

setDefaultTimeout(120_000);

const CHANGE_ROUTINE =
  "opengeni_private.update_organization_inference_residency_v1(uuid, text, text, boolean, bigint, uuid)";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let runtime: postgres.Sql;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-inference-residency");
  if (!acquired) throw new Error("EU-only inference tests require PostgreSQL");
  shared = acquired;
  // Run as the runtime will once the change function 0999 withholds is granted;
  // one test checks the behaviour while it is still withheld.
  await grantDeferredRuntimeAccess(shared.admin);
  client = createDb(shared.appUrl);
  runtime = postgres(shared.appUrl, { max: 1, prepare: false, onnotice: () => undefined });
}, 180_000);

afterAll(async () => {
  await runtime?.end({ timeout: 5 }).catch(() => undefined);
  await client?.close();
  await shared?.release();
});

async function organization() {
  const userId = `eu-only-${crypto.randomUUID()}`;
  const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "EU-only owner",
  });
  const membership = provisioned.organizationMemberships[0]!;
  const sharedWorkspaceId = provisioned.accessContext.workspaceGrants.find(
    (grant) =>
      grant.accountId === membership.organizationId &&
      grant.workspaceId !== membership.personalWorkspaceId,
  )?.workspaceId;
  if (!sharedWorkspaceId) throw new Error("fixture has no shared workspace");
  return {
    organizationId: membership.organizationId,
    owner: `user:${userId}`,
    personalWorkspaceId: membership.personalWorkspaceId!,
    sharedWorkspaceId,
  };
}

async function addMember(org: Awaited<ReturnType<typeof organization>>): Promise<string> {
  return (await join(org, "member")).membership.subjectId;
}

async function join(org: Awaited<ReturnType<typeof organization>>, role: "member" | "admin") {
  const userId = `eu-only-member-${crypto.randomUUID()}`;
  const member = `user:${userId}`;
  await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "EU-only member",
  });
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: org.organizationId,
    actorSubjectId: org.owner,
    operationId: crypto.randomUUID(),
    targetSubjectId: member,
    targetEmail: `${userId}@example.test`,
    role,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  return await acceptOrganizationInvitation(client.db, {
    organizationId: org.organizationId,
    actorSubjectId: member,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
}

function changer(org: { organizationId: string; owner: string }) {
  return (input: {
    actorKind: InferenceResidencyActorKind;
    euOnly: boolean;
    expectedVersion: number;
    actorSubjectId?: string;
    operationId?: string;
  }) =>
    updateOrganizationInferenceResidency(client.db, {
      organizationId: org.organizationId,
      actorSubjectId: org.owner,
      operationId: crypto.randomUUID(),
      ...input,
    });
}

async function refusal(action: Promise<unknown>): Promise<string> {
  const error = await action.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(InferenceResidencyChangeRefusedError);
  return (error as InferenceResidencyChangeRefusedError).reason;
}

test("EU-only is off until turned on, then applies to every workspace, Personal included", async () => {
  const org = await organization();
  const euOnly = (workspaceId: string) =>
    isWorkspaceEuOnly(client.db, { accountId: org.organizationId, workspaceId });

  expect(await getOrganizationInferenceResidency(client.db, org.organizationId)).toMatchObject({
    euOnly: false,
    version: 0,
    updatedAt: null,
  });
  expect(await euOnly(org.sharedWorkspaceId)).toBe(false);
  expect(await euOnly(org.personalWorkspaceId)).toBe(false);

  const on = await changer(org)({ actorKind: "agent", euOnly: true, expectedVersion: 0 });
  expect(on).toMatchObject({ euOnly: true, version: 1, changed: true, replayed: false });
  expect(await euOnly(org.sharedWorkspaceId)).toBe(true);
  expect(await euOnly(org.personalWorkspaceId)).toBe(true);
});

test("isWorkspaceEuOnly resolves the workspace's own account and throws when it cannot", async () => {
  const org = await organization();
  const other = await organization();
  await changer(other)({ actorKind: "browser_person", euOnly: true, expectedVersion: 0 });
  // Another organization's EU-only workspace, asked under this account.
  await expect(
    isWorkspaceEuOnly(client.db, {
      accountId: org.organizationId,
      workspaceId: other.sharedWorkspaceId,
    }),
  ).rejects.toBeInstanceOf(WorkspaceInferenceResidencyUnknownError);
  // A workspace that does not exist.
  await expect(
    isWorkspaceEuOnly(client.db, {
      accountId: other.organizationId,
      workspaceId: crypto.randomUUID(),
    }),
  ).rejects.toBeInstanceOf(WorkspaceInferenceResidencyUnknownError);
  // An account that does not exist.
  await expect(
    isWorkspaceEuOnly(client.db, {
      accountId: crypto.randomUUID(),
      workspaceId: other.sharedWorkspaceId,
    }),
  ).rejects.toBeInstanceOf(WorkspaceInferenceResidencyUnknownError);
  expect(
    await isWorkspaceEuOnly(client.db, {
      accountId: other.organizationId,
      workspaceId: other.sharedWorkspaceId,
    }),
  ).toBe(true);
});

test("only an owner or admin person in a browser turns EU-only off", async () => {
  const org = await organization();
  const change = changer(org);
  await change({ actorKind: "api_key", euOnly: true, expectedVersion: 0 });

  for (const actorKind of ["agent", "api_key"] as const) {
    expect(await refusal(change({ actorKind, euOnly: false, expectedVersion: 1 }))).toBe(
      "forbidden",
    );
  }
  // An API key subject can never claim to be a browser person.
  expect(
    await refusal(
      change({
        actorKind: "browser_person",
        actorSubjectId: `api_key:${crypto.randomUUID()}`,
        euOnly: false,
        expectedVersion: 1,
      }),
    ),
  ).toBe("invalid");
  expect((await getOrganizationInferenceResidency(client.db, org.organizationId)).euOnly).toBe(
    true,
  );

  const off = await change({ actorKind: "browser_person", euOnly: false, expectedVersion: 1 });
  expect(off).toMatchObject({ euOnly: false, version: 2, changed: true });
});

test("members and strangers are refused, and changes need the current version", async () => {
  const org = await organization();
  const member = await addMember(org);
  const change = changer(org);
  for (const actorSubjectId of [member, `user:stranger-${crypto.randomUUID()}`]) {
    for (const euOnly of [true, false]) {
      expect(
        await refusal(
          change({ actorKind: "browser_person", actorSubjectId, euOnly, expectedVersion: 0 }),
        ),
      ).toBe("forbidden");
    }
  }
  expect((await getOrganizationInferenceResidency(client.db, org.organizationId)).version).toBe(0);

  expect(
    await refusal(change({ actorKind: "browser_person", euOnly: true, expectedVersion: 3 })),
  ).toBe("version_conflict");
});

test("an operation id replays its stored result and refuses a different request", async () => {
  const org = await organization();
  const change = changer(org);
  const operationId = crypto.randomUUID();
  const on = { actorKind: "agent" as const, euOnly: true, expectedVersion: 0, operationId };
  const first = await change(on);
  expect(first).toMatchObject({ euOnly: true, version: 1, changed: true, replayed: false });
  await change({ actorKind: "browser_person", euOnly: false, expectedVersion: 1 });

  // The same request returns what it did then, not today's state.
  expect(await change(on)).toEqual({ ...first, replayed: true });
  for (const reused of [
    { ...on, euOnly: false, actorKind: "browser_person" as const },
    { ...on, expectedVersion: 2 },
    { ...on, actorKind: "api_key" as const },
  ]) {
    expect(await refusal(change(reused))).toBe("operation_reused");
  }
  const member = await addMember(org);
  expect(await refusal(change({ ...on, actorSubjectId: member }))).toBe("forbidden");

  const events = await shared.admin`
    select actor_kind, requested_eu_only, expected_version::int as expected_version,
      previous_eu_only, result_eu_only, result_version::int as result_version, changed
    from organization_inference_residency_events
    where account_id = ${org.organizationId}::uuid order by result_version`;
  expect([...events]).toEqual([
    {
      actor_kind: "agent",
      requested_eu_only: true,
      expected_version: 0,
      previous_eu_only: false,
      result_eu_only: true,
      result_version: 1,
      changed: true,
    },
    {
      actor_kind: "browser_person",
      requested_eu_only: false,
      expected_version: 1,
      previous_eu_only: true,
      result_eu_only: false,
      result_version: 2,
      changed: true,
    },
  ]);
});

test("the history refuses an off change by anyone else and a repeated version", async () => {
  const org = await organization();
  const other = await organization();
  const operationId = crypto.randomUUID();
  await changer(org)({ actorKind: "agent", euOnly: true, expectedVersion: 0, operationId });
  // The same operation id in another organization is a different operation.
  expect(
    await changer(other)({ actorKind: "agent", euOnly: true, expectedVersion: 0, operationId }),
  ).toMatchObject({ changed: true, replayed: false });

  const insert = (actorKind: string, requested: boolean, version: number, changed = true) =>
    shared.admin`
      insert into organization_inference_residency_events (
        account_id, id, actor_subject_id, actor_kind, requested_eu_only, expected_version,
        previous_eu_only, result_eu_only, result_version, result_updated_at, changed
      ) values (
        ${org.organizationId}::uuid, ${crypto.randomUUID()}::uuid, ${org.owner}, ${actorKind},
        ${requested}, ${version - 1}, true, ${requested}, ${version}, now(), ${changed}
      )`.then(
      () => null,
      (error: unknown) => String(error),
    );
  expect(await insert("agent", false, 2)).toContain(
    "organization_inference_residency_events_off_by_person_chk",
  );
  expect(await insert("browser_person", true, 1)).toContain(
    "organization_inference_residency_events_version_key",
  );
  // An unchanged request repeats the current version.
  expect(await insert("agent", true, 1, false)).toBeNull();
});

test("a request that changes nothing keeps the version, so it never makes others stale", async () => {
  const org = await organization();
  const change = changer(org);
  const offFirst = await change({ actorKind: "browser_person", euOnly: false, expectedVersion: 0 });
  expect(offFirst).toMatchObject({ euOnly: false, version: 0, updatedAt: null, changed: false });
  const on = await change({ actorKind: "agent", euOnly: true, expectedVersion: 0 });
  expect(on).toMatchObject({ euOnly: true, version: 1, changed: true });
  for (let repeat = 0; repeat < 2; repeat += 1) {
    expect(await change({ actorKind: "agent", euOnly: true, expectedVersion: 1 })).toEqual({
      ...on,
      changed: false,
      replayed: false,
    });
  }
  // The owner's off, made against version 1, still applies.
  expect(
    await change({ actorKind: "browser_person", euOnly: false, expectedVersion: 1 }),
  ).toMatchObject({ euOnly: false, version: 2, changed: true });
  const events = await shared.admin`
    select result_version::int as version, changed
    from organization_inference_residency_events
    where account_id = ${org.organizationId}::uuid order by created_at`;
  expect([...events]).toEqual([
    { version: 0, changed: false },
    { version: 1, changed: true },
    { version: 1, changed: false },
    { version: 1, changed: false },
    { version: 2, changed: true },
  ]);
});

test("an admin who lost the role cannot replay an operation id", async () => {
  const org = await organization();
  const { membership } = await join(org, "admin");
  const operationId = crypto.randomUUID();
  const on = {
    actorKind: "agent" as const,
    euOnly: true,
    expectedVersion: 0,
    operationId,
    actorSubjectId: membership.subjectId,
  };
  expect(await changer(org)(on)).toMatchObject({ changed: true, replayed: false });
  expect(await changer(org)(on)).toMatchObject({ replayed: true });
  await updateOrganizationMember(client.db, {
    organizationId: org.organizationId,
    actorSubjectId: org.owner,
    operationId: crypto.randomUUID(),
    membershipId: membership.id,
    transition: {
      kind: "change_role",
      role: "member",
      expectedAuthorizationRevision: membership.authorizationRevision,
      operationId: crypto.randomUUID(),
    },
  });
  expect(await refusal(changer(org)(on))).toBe("forbidden");
});

test("the runtime reads the setting but never writes it or reads the history directly", async () => {
  const org = await organization();
  await changer(org)({ actorKind: "agent", euOnly: true, expectedVersion: 0 });
  const scoped = async (statement: string) =>
    await runtime.begin(async (sql) => {
      await sql`select set_config('opengeni.account_id', ${org.organizationId}, true)`;
      await sql`select set_config('opengeni.organization_inference_residency_lifecycle', 'active', true)`;
      return [...(await sql.unsafe(statement))] as Record<string, unknown>[];
    });
  expect(
    await scoped(
      `select eu_only from organization_inference_residency where account_id = '${org.organizationId}'`,
    ),
  ).toEqual([{ eu_only: true }]);
  for (const statement of [
    `update organization_inference_residency set eu_only = false where account_id = '${org.organizationId}'`,
    `delete from organization_inference_residency where account_id = '${org.organizationId}'`,
    `insert into organization_inference_residency (account_id, eu_only, version, updated_by_subject_id) values ('${org.organizationId}', false, 9, 'user:x')`,
    `select * from organization_inference_residency_events`,
  ]) {
    const error = await scoped(statement).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(nestedPostgresSqlState(error)).toBe("42501");
  }
  expect((await getOrganizationInferenceResidency(client.db, org.organizationId)).euOnly).toBe(
    true,
  );
});

test("until the change function is granted, the setting cannot change and stays off", async () => {
  const org = await organization();
  await shared.admin.unsafe(`REVOKE EXECUTE ON FUNCTION ${CHANGE_ROUTINE} FROM opengeni_app`);
  try {
    expect(
      await refusal(
        changer(org)({ actorKind: "browser_person", euOnly: true, expectedVersion: 0 }),
      ),
    ).toBe("unavailable");
    expect(
      await isWorkspaceEuOnly(client.db, {
        accountId: org.organizationId,
        workspaceId: org.sharedWorkspaceId,
      }),
    ).toBe(false);
  } finally {
    await grantDeferredRuntimeAccess(shared.admin);
  }
});
