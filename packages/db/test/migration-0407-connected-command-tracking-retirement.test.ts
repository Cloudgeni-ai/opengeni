// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { bootstrapWorkspace, createDb, createEnrollment, createSession } from "../src/index";
import { claimConnectedMachineSessionBackgroundCommands } from "../src/session-background-commands";

let shared: OwnerMigratedTestDatabase;
let client: ReturnType<typeof createDb>;
let owner: ReturnType<typeof postgres>;
beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("command-tracking-retirement");
  if (!acquired) throw new Error("PostgreSQL required for command retirement tests");
  shared = acquired;
  await migrate(shared.ownerUrl);
  await provisionRoles(shared.adminUrl, { appPassword: shared.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(shared.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = shared.appPassword;
  client = createDb(appUrl.toString(), { rlsStrategy: "force" });
  owner = postgres(shared.ownerUrl, { max: 1 });
}, 900_000);
afterAll(async () => {
  await owner?.end();
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(
  kind: "replaced" | "stopped" | "offline" | "revoked" | "current",
  proof = false,
) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Command lifecycle",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Command lifecycle",
    subjectId: `subject-${suffix}`,
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId,
    workspaceId: workspaceId!,
    initialMessage: "command lifecycle",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const enrollment = await createEnrollment(client.db, {
    accountId,
    workspaceId: workspaceId!,
    pubkey: `ed25519:${suffix}`,
  });
  const connection = kind === "replaced" ? "successor" : kind === "stopped" ? null : "launch";
  await shared.admin`update enrollments set connection_instance_id = ${connection},
    connection_lease_expires_at = ${connection ? new Date(Date.now() - 60_000) : null},
    went_offline_reason = ${kind === "stopped" ? "GOING_OFFLINE_REASON_USER_STOP" : null},
    went_offline_at = ${kind === "stopped" ? new Date() : null},
    status = ${kind === "revoked" ? "revoked" : "active"}
    where id = ${enrollment.id}`;
  const id = crypto.randomUUID();
  await shared.admin`insert into session_background_commands
    (id,account_id,workspace_id,session_id,provider,state,control_workspace_id,enrollment_id,
     connection_instance_id,op_id,cancel_requested_at,cancel_requested_by,
     reconcile_proof_outcome,reconcile_proof_exit_code,reconcile_proof_reason,reconcile_proof_observed_at)
    values (${id},${accountId},${workspaceId!},${session.id},'connected_machine','stopping',
      ${workspaceId!},${enrollment.id},'launch',${id},now(),'test',
      ${proof ? "exited" : null},${proof ? 0 : null},${proof ? "op_exit" : null},${proof ? new Date() : null})`;
  return { id, sessionId: session.id, workspaceId: workspaceId! };
}

const source = await readFile(
  new URL("../drizzle/0407_connected_command_tracking_retirement.sql", import.meta.url),
  "utf8",
);
test("historical repair retires ended tracking without notifications, preserving offline commands and saved exits", async () => {
  const replaced = await fixture("replaced");
  const stopped = await fixture("stopped");
  const revoked = await fixture("revoked");
  const offline = await fixture("offline");
  const proven = await fixture("replaced", true);
  const [before] = await shared.admin`select count(*)::int n from session_system_updates`;
  await owner.begin(async (tx) => {
    await tx.unsafe(
      source.slice(source.indexOf("DO $repair$"), source.indexOf("-- Keep the three-argument")),
    );
  });
  const rows =
    await shared.admin`select id,state,settlement_reason from session_background_commands`;
  for (const value of [replaced, stopped, revoked])
    expect(rows.find((r) => r.id === value.id)?.state).toBe("lost");
  for (const value of [offline, proven])
    expect(rows.find((r) => r.id === value.id)?.state).toBe("stopping");
  const [after] = await shared.admin`select count(*)::int n from session_system_updates`;
  expect(after!.n).toBe(before!.n);
  const [events] =
    await shared.admin`select count(*)::int n from session_events where type='session.command.finished'`;
  expect(events!.n).toBe(0);
});

test("runtime claims classify retirement, preserve exact exit proof, and never treat lease expiry as loss", async () => {
  const replaced = await fixture("replaced");
  const stopped = await fixture("stopped");
  const revoked = await fixture("revoked");
  const offline = await fixture("offline");
  const proven = await fixture("replaced", true);
  const claims = await claimConnectedMachineSessionBackgroundCommands(client.db, {
    claimId: crypto.randomUUID(),
    limit: 100,
    claimTtlMs: 300_000,
    dueBefore: new Date(),
  });
  const reason = (id: string) => claims.find((c) => c.commandId === id)?.proof?.reason;
  expect(reason(replaced.id)).toBe("op_connection_replaced");
  expect(reason(stopped.id)).toBe("op_connection_stopped");
  expect(reason(revoked.id)).toBe("op_enrollment_revoked");
  expect(claims.find((c) => c.commandId === offline.id)?.proof).toBeNull();
  expect(claims.find((c) => c.commandId === proven.id)?.proof).toMatchObject({
    outcome: "exited",
    exitCode: 0,
    reason: "op_exit",
  });
  const second = await claimConnectedMachineSessionBackgroundCommands(client.db, {
    claimId: crypto.randomUUID(),
    limit: 100,
    claimTtlMs: 300_000,
    dueBefore: new Date(),
  });
  expect(second).toHaveLength(0);
});

test("a fixed frontier drains multiple batches without revisiting claims even with zero claim TTL", async () => {
  const value = await fixture("current");
  await shared.admin`insert into session_background_commands
    (account_id,workspace_id,session_id,provider,state,control_workspace_id,enrollment_id,connection_instance_id,op_id)
    select account_id,workspace_id,session_id,provider,'running',control_workspace_id,enrollment_id,connection_instance_id,gen_random_uuid()::text
    from session_background_commands cross join generate_series(1,24) where id=${value.id}`;
  const dueBefore = new Date();
  const claim = () =>
    claimConnectedMachineSessionBackgroundCommands(client.db, {
      claimId: crypto.randomUUID(),
      limit: 20,
      claimTtlMs: 0,
      dueBefore,
    });
  const first = await claim();
  const second = await claim();
  expect(first).toHaveLength(20);
  expect(second).toHaveLength(5);
  expect(new Set([...first, ...second].map((c) => c.commandId)).size).toBe(25);
  expect(await claim()).toHaveLength(0);
});
