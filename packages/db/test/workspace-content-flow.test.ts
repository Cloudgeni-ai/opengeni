import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";

import {
  assertOrganizationContentFlowAllowed,
  assertWorkspaceContentExchangeAllowed,
  assertWorkspaceContentFlowAllowed,
  createDb,
  ensureManagedAccessForUserWithOrganizationMemberships,
  updateOrganizationInferenceResidency,
  WorkspaceContentFlowRefusedError,
  workspaceContentFlowEnd,
  type Database,
  type WorkspaceContentFlowEnd,
} from "../src/index";

setDefaultTimeout(120_000);

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workspace-content-flow");
  if (!acquired) throw new Error("EU-only content flow tests require PostgreSQL");
  shared = acquired;
  // As the runtime will once 0981 grants the change function; tests turn EU-only on.
  await grantDeferredRuntimeAccess(shared.admin);
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

async function organization(euOnly: boolean) {
  const userId = `eu-flow-${crypto.randomUUID()}`;
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
  if (euOnly) {
    await updateOrganizationInferenceResidency(client.db, {
      organizationId: membership.organizationId,
      actorSubjectId: `user:${userId}`,
      actorKind: "browser_person",
      euOnly: true,
      expectedVersion: 0,
      operationId: crypto.randomUUID(),
    });
  }
  const end = (workspaceId: string): WorkspaceContentFlowEnd => ({
    accountId: membership.organizationId,
    workspaceId,
  });
  return { shared: end(sharedWorkspaceId), personal: end(membership.personalWorkspaceId) };
}

const refusal = (promise: Promise<void>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

/** A database whose every read fails, as when the setting can't be read. */
function unreadableDb(): Database {
  return new Proxy({} as Database, {
    get: (_target, property) =>
      property === "then"
        ? undefined
        : () => {
            throw new Error("database unavailable");
          },
  });
}

test("EU-only content reaches EU-only workspaces, in its organization and in another", async () => {
  const eu = await organization(true);
  const otherEu = await organization(true);
  for (const [source, target] of [
    [eu.shared, eu.personal],
    [eu.personal, eu.shared],
    [eu.shared, otherEu.shared],
    [otherEu.personal, eu.personal],
  ] as const) {
    await assertWorkspaceContentFlowAllowed(client.db, { source, target });
    await assertWorkspaceContentExchangeAllowed(client.db, { here: source, there: target });
  }
});

test("EU-only content never reaches a workspace that isn't EU-only", async () => {
  const eu = await organization(true);
  const open = await organization(false);
  for (const target of [open.shared, open.personal]) {
    const refused = await refusal(
      assertWorkspaceContentFlowAllowed(client.db, { source: eu.shared, target }),
    );
    expect(refused).toBeInstanceOf(WorkspaceContentFlowRefusedError);
    expect(refused).toMatchObject({
      code: "region_restricted",
      sourceWorkspaceId: eu.shared.workspaceId,
      targetWorkspaceId: target.workspaceId,
    });
  }
  // An exchange carries content both ways, so either side being EU-only refuses it.
  for (const [here, there] of [
    [eu.personal, open.shared],
    [open.shared, eu.personal],
  ] as const) {
    const refused = await refusal(
      assertWorkspaceContentExchangeAllowed(client.db, { here, there }),
    );
    expect(refused).toMatchObject({
      code: "region_restricted",
      sourceWorkspaceId: eu.personal.workspaceId,
      targetWorkspaceId: open.shared.workspaceId,
    });
  }
});

test("other content may go into an EU-only workspace, and moves freely elsewhere", async () => {
  const eu = await organization(true);
  const open = await organization(false);
  const otherOpen = await organization(false);
  await assertWorkspaceContentFlowAllowed(client.db, { source: open.shared, target: eu.shared });
  await assertWorkspaceContentFlowAllowed(client.db, {
    source: open.personal,
    target: otherOpen.shared,
  });
  await assertWorkspaceContentExchangeAllowed(client.db, {
    here: open.shared,
    there: otherOpen.personal,
  });
});

test("every check is for the exact workspace pair, with the organization read from the workspace", async () => {
  const eu = await organization(true);
  const open = await organization(false);
  expect(await workspaceContentFlowEnd(client.db, open.shared.workspaceId)).toEqual(open.shared);
  expect(await workspaceContentFlowEnd(client.db, crypto.randomUUID())).toBeNull();
  // The same workspace is never a move.
  await assertWorkspaceContentFlowAllowed(client.db, { source: eu.shared, target: eu.shared });
});

test("a setting that can't be read refuses the move", async () => {
  const eu = await organization(true);
  const open = await organization(false);
  const closed = { db: unreadableDb() };
  for (const check of [
    () => assertWorkspaceContentFlowAllowed(closed.db, { source: eu.shared, target: open.shared }),
    () => assertWorkspaceContentFlowAllowed(closed.db, { source: open.shared, target: eu.shared }),
    () => assertWorkspaceContentExchangeAllowed(closed.db, { here: open.shared, there: eu.shared }),
    () => workspaceContentFlowEnd(closed.db, open.shared.workspaceId).then(() => undefined),
  ]) {
    const failed = await refusal(check());
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(WorkspaceContentFlowRefusedError);
  }
  // A workspace named with another organization's id has no setting to read.
  const misnamed = { accountId: open.shared.accountId, workspaceId: eu.shared.workspaceId };
  const failed = await refusal(
    assertWorkspaceContentFlowAllowed(client.db, { source: misnamed, target: open.shared }),
  );
  expect(failed).toBeInstanceOf(Error);
  expect(failed).not.toBeInstanceOf(WorkspaceContentFlowRefusedError);
});

test("an organization-wide reach: refused only when the organization has EU-only content", async () => {
  const eu = await organization(true);
  const euElsewhere = await organization(true);
  const open = await organization(false);
  const org = (source: { shared: WorkspaceContentFlowEnd }, target: WorkspaceContentFlowEnd) =>
    assertOrganizationContentFlowAllowed(client.db, {
      sourceAccountId: source.shared.accountId,
      target,
    });
  expect(await refusal(org(eu, open.shared))).toMatchObject({
    code: "region_restricted",
    targetWorkspaceId: open.shared.workspaceId,
  });
  expect(await refusal(org(eu, open.personal))).toBeInstanceOf(WorkspaceContentFlowRefusedError);
  await org(eu, euElsewhere.shared);
  await org(eu, eu.personal);
  await org(open, eu.shared);
  await org(open, open.personal);
});

test("an organization-wide reach fails closed", async () => {
  const eu = await organization(true);
  const open = await organization(false);
  // No such organization, or one that can't be read: never "not EU-only".
  for (const check of [
    () =>
      assertOrganizationContentFlowAllowed(client.db, {
        sourceAccountId: crypto.randomUUID(),
        target: open.shared,
      }),
    () =>
      assertOrganizationContentFlowAllowed(unreadableDb(), {
        sourceAccountId: eu.shared.accountId,
        target: open.shared,
      }),
  ]) {
    const failed = await refusal(check());
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(WorkspaceContentFlowRefusedError);
  }
});
