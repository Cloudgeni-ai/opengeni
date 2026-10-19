import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  countOnlineMachines,
  createDb,
  createSandboxEnrollment,
  finalizeEnrollmentByToken,
  getEnrollment,
  getLiveEnrollmentConnection,
  listEnrollments,
  listSandboxes,
  openSandboxAgentLink,
  releaseSandboxAgentLink,
  renewEnrollmentConnection,
  renewSandboxAgentLink,
  revokeSandboxEnrollment,
  SandboxEnrollmentConflictError,
  type Database,
  type DbClient,
} from "../src/index";

// 0852: Opengeni creates the enrollment of the agent inside each compute
// sandbox itself. It is kind 'sandbox', bound to the sandbox's group, has no
// key or bearer, is never a machine (no sandboxes row, not listed, not
// counted), is fenced by the control service's owner epoch at the agent gateway and is
// revoked when the sandbox is deleted. Runs as opengeni_app so FORCE RLS applies.

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

const LEASE_MS = 20_000;

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id };
}

async function sandboxEnrollment(ws: { accountId: string; workspaceId: string }) {
  return await createSandboxEnrollment(db, {
    ...ws,
    enrollmentId: crypto.randomUUID(),
    sandboxGroupId: crypto.randomUUID(),
    hasDisplay: false,
    workspaceRoot: "/workspace",
  });
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("sandbox-enrollments");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[sandbox-enrollments] postgres unavailable, skipping");
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

describe("sandbox enrollments", () => {
  test("Opengeni creates a sandbox enrollment active, keyless and idempotent", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const input = {
      ...ws,
      enrollmentId: crypto.randomUUID(),
      sandboxGroupId: crypto.randomUUID(),
      hasDisplay: true,
      workspaceRoot: "/workspace",
    };
    const created = await createSandboxEnrollment(db, input);
    expect(created).toMatchObject({
      id: input.enrollmentId,
      kind: "sandbox",
      sandboxGroupId: input.sandboxGroupId,
      scope: "workspace",
      pubkey: null,
      hasDisplay: true,
      allowScreenControl: true,
      workspaceRoot: "/workspace",
      status: "active",
    });
    expect((await createSandboxEnrollment(db, input)).id).toBe(input.enrollmentId);
    // The same id under another group is a conflict, never a silent rebind.
    await expect(
      createSandboxEnrollment(db, { ...input, sandboxGroupId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(SandboxEnrollmentConflictError);
    expect((await getEnrollment(db, ws.workspaceId, input.enrollmentId))?.kind).toBe("sandbox");
  });

  test("a sandbox enrollment is never a machine", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const machine = await finalizeEnrollmentByToken(db, {
      ...ws,
      pubkey: "ed25519:machine",
      hasDisplay: false,
      allowScreenControl: false,
      os: "linux",
      arch: "x86_64",
      sandboxName: "laptop",
    });
    const box = await sandboxEnrollment(ws);
    await admin`
      update enrollments set last_seen_at = now()
      where id in (${machine.enrollment.id}, ${box.id})`;

    expect((await listEnrollments(db, ws.workspaceId)).map((e) => e.id)).toEqual([
      machine.enrollment.id,
    ]);
    expect(
      (await listEnrollments(db, ws.workspaceId, { status: "active" })).map((e) => e.id),
    ).toEqual([machine.enrollment.id]);
    expect((await listSandboxes(db, ws.workspaceId)).map((s) => s.enrollmentId)).toEqual([
      machine.enrollment.id,
    ]);
    expect(await countOnlineMachines(db, ws.workspaceId, 60_000)).toBe(1);
  });

  test("the database keeps machines keyed and sandboxes keyless and grouped", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    // postgres.js queries are lazy thenables; run each as a real promise.
    const insert = async (pubkey: string | null, kind: string, group: string | null) => {
      await admin`
        insert into enrollments (account_id, workspace_id, pubkey, kind, sandbox_group_id)
        values (${ws.accountId}, ${ws.workspaceId}, ${pubkey}, ${kind}, ${group})`;
    };
    await expect(insert(null, "sandbox", null)).rejects.toThrow(
      /enrollments_sandbox_binding_check/,
    );
    await expect(insert("ed25519:keyed", "sandbox", crypto.randomUUID())).rejects.toThrow(
      /enrollments_sandbox_binding_check/,
    );
    await expect(insert(null, "machine", null)).rejects.toThrow(
      /enrollments_sandbox_binding_check/,
    );
    await expect(insert("ed25519:odd", "box", null)).rejects.toThrow(/enrollments_kind_check/);
  });

  test("the gateway's link is fenced by the owner epoch and claims like the callout", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const box = await sandboxEnrollment(ws);
    const link = (epoch: number, connectionInstanceId: string) => ({
      workspaceId: ws.workspaceId,
      agentId: box.id,
      epoch,
      connectionInstanceId,
      leaseMs: LEASE_MS,
    });
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();

    expect(await openSandboxAgentLink(db, link(3, first))).toEqual({
      opened: true,
      connectionGeneration: 1,
      superseded: false,
    });
    expect(
      (await getLiveEnrollmentConnection(db, ws.workspaceId, box.id))?.connectionInstanceId,
    ).toBe(first);
    // The same instance may reopen (a host's link came back).
    expect(await openSandboxAgentLink(db, link(3, first))).toMatchObject({
      opened: true,
      connectionGeneration: 1,
    });
    // Another instance at the same epoch waits for the live lease.
    expect(await openSandboxAgentLink(db, link(3, second))).toEqual({
      opened: false,
      code: "duplicate",
    });
    // An older epoch is refused.
    expect(await openSandboxAgentLink(db, link(2, second))).toEqual({
      opened: false,
      code: "stale_epoch",
    });
    expect(await renewSandboxAgentLink(db, link(3, first))).toEqual({ renewed: true });

    // The sandbox moved: a later epoch takes the claim at once and the old
    // session ends superseded at its next renewal.
    expect(await openSandboxAgentLink(db, link(5, second))).toEqual({
      opened: true,
      connectionGeneration: 2,
      superseded: true,
    });
    expect(await renewSandboxAgentLink(db, link(3, first))).toEqual({
      renewed: false,
      code: "superseded",
    });
    expect(await renewSandboxAgentLink(db, link(5, second))).toEqual({ renewed: true });
    // Releasing the old session changes nothing; releasing the current one
    // lets the agent's next instance open without waiting for the lease.
    expect(await releaseSandboxAgentLink(db, link(3, first))).toEqual({ released: false });
    expect(await releaseSandboxAgentLink(db, link(5, second))).toEqual({ released: true });
    expect(await getLiveEnrollmentConnection(db, ws.workspaceId, box.id)).toBeNull();
    const third = crypto.randomUUID();
    expect(await openSandboxAgentLink(db, link(5, third))).toMatchObject({
      opened: true,
      connectionGeneration: 3,
    });
    expect(await renewSandboxAgentLink(db, link(5, second))).toEqual({
      renewed: false,
      code: "lost",
    });
    // An awake agent's heartbeat renews the same claim, as on a machine.
    expect(
      await renewEnrollmentConnection(db, {
        ...ws,
        enrollmentId: box.id,
        connectionInstanceId: third,
        leaseMs: LEASE_MS,
      }),
    ).toEqual({ renewed: true });
  });

  test("a machine never opens a sandbox link", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const machine = await finalizeEnrollmentByToken(db, {
      ...ws,
      pubkey: "ed25519:machine",
      hasDisplay: false,
      allowScreenControl: false,
      os: "linux",
      arch: "x86_64",
      sandboxName: "laptop",
    });
    expect(
      await openSandboxAgentLink(db, {
        workspaceId: ws.workspaceId,
        agentId: machine.enrollment.id,
        epoch: 1,
        connectionInstanceId: crypto.randomUUID(),
        leaseMs: LEASE_MS,
      }),
    ).toEqual({ opened: false, code: "unknown_agent" });
    expect(
      await openSandboxAgentLink(db, {
        workspaceId: ws.workspaceId,
        agentId: crypto.randomUUID(),
        epoch: 1,
        connectionInstanceId: crypto.randomUUID(),
        leaseMs: LEASE_MS,
      }),
    ).toEqual({ opened: false, code: "unknown_agent" });
  });

  test("revoking a sandbox enrollment ends its link and never touches a machine", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const machine = await finalizeEnrollmentByToken(db, {
      ...ws,
      pubkey: "ed25519:machine",
      hasDisplay: false,
      allowScreenControl: false,
      os: "linux",
      arch: "x86_64",
      sandboxName: "laptop",
    });
    const box = await sandboxEnrollment(ws);
    const link = {
      workspaceId: ws.workspaceId,
      agentId: box.id,
      epoch: 1,
      connectionInstanceId: crypto.randomUUID(),
      leaseMs: LEASE_MS,
    };
    expect((await openSandboxAgentLink(db, link)).opened).toBe(true);
    expect(await getLiveEnrollmentConnection(db, ws.workspaceId, box.id)).not.toBeNull();

    expect(
      await revokeSandboxEnrollment(db, { workspaceId: ws.workspaceId, enrollmentId: box.id }),
    ).toEqual({ revoked: true });
    expect(
      await revokeSandboxEnrollment(db, { workspaceId: ws.workspaceId, enrollmentId: box.id }),
    ).toEqual({ revoked: false });
    expect(await getLiveEnrollmentConnection(db, ws.workspaceId, box.id)).toBeNull();
    expect(await renewSandboxAgentLink(db, link)).toEqual({ renewed: false, code: "revoked" });
    expect(await openSandboxAgentLink(db, link)).toEqual({ opened: false, code: "revoked" });
    expect(
      await revokeSandboxEnrollment(db, {
        workspaceId: ws.workspaceId,
        enrollmentId: machine.enrollment.id,
      }),
    ).toEqual({ revoked: false });
    expect((await getEnrollment(db, ws.workspaceId, machine.enrollment.id))?.status).toBe("active");
  });
});
