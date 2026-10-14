import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  bootstrapWorkspace,
  createDb,
  lockExternalWorkspaceMembershipLifecycle,
  withWorkspaceSessionActivityRls,
  type Database,
} from "../src";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(60_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("membership-fence-order");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

// An external-actor request (realtime sync, linked Send/Steer) reauthorizes
// under the organization-membership lock. The canonical order is membership ->
// session tenancy -> workspace control -> workspace -> session -> turn -> attempt;
// taking the shared tenancy fence first deadlocks against an organization
// lifecycle that holds membership and waits for exclusive tenancy.
test("external reauthorization takes the membership lock before the tenancy fence", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Membership fence order",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Membership fence order",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  let request: Promise<string> | undefined;
  await shared.admin.begin(async (lifecycle) => {
    await lifecycle`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${grant.accountId}`}, 0))`;
    request = withWorkspaceSessionActivityRls(
      client.db,
      workspaceId,
      async (scoped) => {
        await lockExternalWorkspaceMembershipLifecycle(
          scoped as unknown as Database,
          grant.accountId,
        );
        return "authorized";
      },
      undefined,
      true,
    );
    await Bun.sleep(300);
    // With the old order the request already holds shared tenancy here, and
    // this exclusive wait completes a deadlock cycle.
    await lifecycle`select pg_advisory_xact_lock(hashtextextended(${`session-tenancy:${workspaceId}`}, 0))`;
  });
  expect(await request).toBe("authorized");
});
