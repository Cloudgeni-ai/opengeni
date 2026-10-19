import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createEnrollment,
  sandboxMaintenanceDue,
} from "@opengeni/db";
import { subjectFor, type ControlRpc } from "@opengeni/runtime/sandbox";
import { reconcileConnectedSecretFiles as reconcile } from "../src/activities/sandbox-lease";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("connected-secret-reconciliation");
  if (!db) throw new Error("PostgreSQL required");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

const settings = {
  sandboxLeaseReaperPeriodMs: 30_000,
  sandboxSelfhostedControlTimeoutMs: 1_000,
} as Parameters<typeof reconcile>[1];
const observability = { warn: () => {} } as unknown as Parameters<typeof reconcile>[2];
const bus = { getRequestConnection: async () => null } as unknown as Parameters<
  typeof reconcile
>[3];

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Secret reconciliation",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Secret reconciliation",
    subjectId: `subject-${suffix}`,
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  const enrollment = await createEnrollment(client.db, {
    accountId,
    workspaceId: workspaceId!,
    pubkey: `ed25519:${suffix}`,
  });
  await shared.admin`update enrollments set connection_instance_id='successor',connection_lease_expires_at=now()+interval '1 hour',agent_capabilities='{"secretFileFencing":true}' where id=${enrollment.id}`;
  const id = crypto.randomUUID();
  const scope = `attempt-${suffix}`;
  // A retained obligation whose attempt has been deleted. Registration itself
  // is tested through the canonical live-attempt fence in the database suite.
  await shared.admin`insert into connected_secret_file_scopes
    (id,account_id,workspace_id,session_id,turn_id,attempt_id,execution_generation,
    control_workspace_id,enrollment_id,pubkey,connection_instance_id,scope)
    values (${id},${accountId},${workspaceId!},${crypto.randomUUID()},${crypto.randomUUID()},${crypto.randomUUID()},1,
    ${workspaceId!},${enrollment.id},${enrollment.pubkey},'original',${scope})`;
  return { id, scope, enrollment, workspaceId: workspaceId! };
}

test("reconnect uses the verified successor and a positive native closure receipt", async () => {
  const fixtureValue = await fixture();
  expect(await sandboxMaintenanceDue(client.db, { checkpointArtifactClaimTtlMs: 300_000 })).toBe(
    true,
  );
  const requests: string[] = [];
  const rpc: ControlRpc = {
    request: async (subject, request) => {
      requests.push(subject);
      expect(request.epoch).toBe(0);
      expect(request.op).toEqual({
        $case: "fsRemove",
        fsRemove: {
          path: `/tmp/opengeni-private/secrets/${fixtureValue.scope}`,
          recursive: true,
        },
      });
      return { requestId: request.requestId, result: { $case: "fsRemove", fsRemove: {} } };
    },
  };
  await reconcile(client.db, settings, observability, bus, rpc);
  expect(requests).toEqual([
    subjectFor(fixtureValue.workspaceId, fixtureValue.enrollment.id, "successor"),
  ]);
  expect(
    await shared.admin`select id from connected_secret_file_scopes where id=${fixtureValue.id}`,
  ).toHaveLength(0);
});

test.each(["offline", "key-changed", "old-agent"])(
  "%s cannot be treated as erased",
  async (kind) => {
    const { id, enrollment } = await fixture();
    if (kind === "offline")
      await shared.admin`update enrollments set connection_lease_expires_at=now()-interval '1 minute' where id=${enrollment.id}`;
    if (kind === "key-changed")
      await shared.admin`update enrollments set pubkey=${`ed25519:${crypto.randomUUID()}`} where id=${enrollment.id}`;
    if (kind === "old-agent")
      await shared.admin`update enrollments set agent_capabilities='{}' where id=${enrollment.id}`;
    let sent = false;
    const rpc: ControlRpc = {
      request: async () => {
        sent = true;
        throw new Error("must not dispatch");
      },
    };
    await reconcile(client.db, settings, observability, bus, rpc);
    expect(sent).toBe(false);
    const [row] =
      await shared.admin`select attempts,claim_id,retry_after > now() as delayed from connected_secret_file_scopes where id=${id}`;
    expect(row).toMatchObject({ attempts: 1, claim_id: null, delayed: true });
  },
);

test("an ambiguous timeout retains the obligation and a later receipt clears it", async () => {
  const { id } = await fixture();
  await reconcile(client.db, settings, observability, bus, {
    request: async () => {
      throw new Error("timed out after native closure");
    },
  });
  expect(
    await shared.admin`select id from connected_secret_file_scopes where id=${id}`,
  ).toHaveLength(1);
  await shared.admin`update connected_secret_file_scopes set retry_after=now() where id=${id}`;
  await reconcile(client.db, settings, observability, bus, {
    request: async (_subject, request) => ({
      requestId: request.requestId,
      result: { $case: "fsRemove", fsRemove: {} },
    }),
  });
  expect(
    await shared.admin`select id from connected_secret_file_scopes where id=${id}`,
  ).toHaveLength(0);
});
