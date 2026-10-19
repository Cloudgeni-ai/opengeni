import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  createEnrollment,
  createSandboxEnrollment,
  createSession,
  type Database,
  type DbClient,
} from "../src/index";
import {
  claimConnectedMachineSessionBackgroundCommands,
  requestSessionBackgroundCommandCancellation,
} from "../src/session-background-commands";

// 0849: a message to a compute sandbox's agent wakes the sandbox, so the
// connected-command reconciler never polls a running command on a sandbox
// enrollment. It claims one only after a pushed completion, with a saved
// proof, once the command is retired (connection replaced, enrollment
// revoked), or while it is stopping (the claim delivers the cancellation).
// Connected Machine commands are claimed exactly as before. Runs as
// opengeni_app so FORCE RLS applies.

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("compute-command-reconciliation");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[compute-command-reconciliation] postgres unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

type Kind = "sandbox" | "machine";

async function runningCommand(
  kind: Kind,
  options: { notified?: boolean; replaced?: boolean; revoked?: boolean; stopping?: boolean } = {},
) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "compute-command-test",
    accountExternalId: suffix,
    accountName: "Compute command test",
    workspaceExternalSource: "compute-command-test",
    workspaceExternalId: suffix,
    workspaceName: "Compute command test",
    subjectId: `subject-${suffix}`,
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  const session = await createSession(db, {
    accountId,
    workspaceId: workspaceId!,
    initialMessage: "compute command",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: kind === "sandbox" ? "compute" : "none",
  });
  const enrollment =
    kind === "sandbox"
      ? await createSandboxEnrollment(db, {
          accountId,
          workspaceId: workspaceId!,
          enrollmentId: crypto.randomUUID(),
          sandboxGroupId: session.sandboxGroupId,
          hasDisplay: false,
          workspaceRoot: "/workspace",
        })
      : await createEnrollment(db, {
          accountId,
          workspaceId: workspaceId!,
          pubkey: `ed25519:${suffix}`,
        });
  // A sleeping sandbox keeps its instance; its lease may have lapsed.
  await admin`update enrollments set
    connection_instance_id = ${options.replaced ? "successor" : "launch"},
    connection_lease_expires_at = ${new Date(Date.now() - 60_000)},
    status = ${options.revoked ? "revoked" : "active"}
    where id = ${enrollment.id}`;
  const id = crypto.randomUUID();
  await admin`insert into session_background_commands
    (id, account_id, workspace_id, session_id, provider, state, control_workspace_id,
     enrollment_id, connection_instance_id, op_id, reconcile_after, completion_notified_at)
    values (${id}, ${accountId}, ${workspaceId!}, ${session.id}, 'connected_machine', 'running',
      ${workspaceId!}, ${enrollment.id}, 'launch', ${id}, now() - interval '1 minute',
      ${options.notified ? new Date() : null})`;
  if (options.stopping) {
    const { accepted, stopTarget } = await requestSessionBackgroundCommandCancellation(db, {
      accountId,
      workspaceId: workspaceId!,
      sessionId: session.id,
      commandId: id,
      subjectId: `subject-${suffix}`,
    });
    expect(accepted).toBe(true);
    // The caller delivers the stop at once to the command's frozen locator.
    expect(stopTarget).toEqual({
      controlWorkspaceId: workspaceId!,
      enrollmentId: enrollment.id,
      connectionInstanceId: "launch",
      opId: id,
    });
  }
  return id;
}

async function due(): Promise<boolean> {
  const [row] = await admin<{ due: boolean }[]>`
    select opengeni_private.connected_command_reconciliation_due_v1() as due`;
  return row!.due;
}

async function claim() {
  return await claimConnectedMachineSessionBackgroundCommands(db, {
    claimId: crypto.randomUUID(),
    limit: 100,
    claimTtlMs: 300_000,
    dueBefore: new Date(),
  });
}

describe("connected-command reconciliation on compute sandboxes", () => {
  test("a running command on a live sandbox is neither due nor claimed", async () => {
    if (!available) return;
    const idle = await runningCommand("sandbox");
    expect(await due()).toBe(false);
    expect((await claim()).map((c) => c.commandId)).not.toContain(idle);
    expect(await due()).toBe(false);
  }, 60_000);

  test("pushed completions, retirements and machine commands are still reconciled", async () => {
    if (!available) return;
    const idle = await runningCommand("sandbox");
    const notified = await runningCommand("sandbox", { notified: true });
    const replaced = await runningCommand("sandbox", { replaced: true });
    const revoked = await runningCommand("sandbox", { revoked: true });
    const machine = await runningCommand("machine");
    expect(await due()).toBe(true);
    const claims = await claim();
    const byId = (id: string) => claims.find((c) => c.commandId === id);
    expect(byId(idle)).toBeUndefined();
    expect(byId(notified)?.proof).toBeNull();
    expect(byId(replaced)?.proof?.reason).toBe("op_connection_replaced");
    expect(byId(revoked)?.proof?.reason).toBe("op_enrollment_revoked");
    expect(byId(machine)?.proof).toBeNull();
    // Every claimable row is now leased; only the idle compute command is left.
    expect(await due()).toBe(false);
  }, 60_000);

  test("a cancellation is delivered to a compute command", async () => {
    if (!available) return;
    const stopping = await runningCommand("sandbox", { stopping: true });
    expect(await due()).toBe(true);
    const claimed = (await claim()).find((c) => c.commandId === stopping);
    expect(claimed?.state).toBe("stopping");
    expect(claimed?.proof).toBeNull();
    expect(await due()).toBe(false);
  }, 60_000);
});
