import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
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
  renewSandboxAgentLinks,
  revokeSandboxEnrollment,
  SandboxEnrollmentConflictError,
  type Database,
  type DbClient,
} from "../src/index";

// 0858: Opengeni creates the enrollment of the agent inside each compute
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
    ).toMatchObject({
      renewed: true,
      enrollment: { id: box.id, connectionInstanceId: third },
    });
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

  test("renewal batches the locked decision, database clock and write", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const box = await sandboxEnrollment(ws);
    const link = {
      workspaceId: ws.workspaceId,
      agentId: box.id,
      epoch: 1,
      connectionInstanceId: crypto.randomUUID(),
      leaseMs: LEASE_MS,
    };
    await openSandboxAgentLink(db, link);
    const statements: string[] = [];
    const measured = createDb(shared!.appUrl, { max: 1 });
    const driver = (measured.db as unknown as { $client: postgres.Sql }).$client;
    driver.options.debug = (_connection, query) => {
      statements.push(query);
    };
    try {
      expect(await renewSandboxAgentLink(measured.db, link)).toEqual({ renewed: true });
      expect(statements.filter((query) => /from enrollments/i.test(query))).toHaveLength(1);
      expect(statements.filter((query) => /clock_timestamp\(\)/i.test(query))).toHaveLength(1);
      expect(statements.some((query) => /^select clock_timestamp/i.test(query))).toBe(false);
    } finally {
      await measured.close();
    }
  });

  test("renewal preserves long heartbeat leases and exact refusal precedence", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const box = await sandboxEnrollment(ws);
    const link = {
      workspaceId: ws.workspaceId,
      agentId: box.id,
      epoch: 1,
      connectionInstanceId: crypto.randomUUID(),
      leaseMs: LEASE_MS,
    };
    await openSandboxAgentLink(db, link);
    const [future] = await admin`update enrollments set
      connection_lease_expires_at = date_trunc('milliseconds',clock_timestamp()) + interval '1 hour'
      where id=${box.id} returning connection_lease_expires_at`;
    expect(await renewSandboxAgentLink(db, link)).toEqual({ renewed: true });
    const [current] =
      await admin`select connection_lease_expires_at from enrollments where id=${box.id}`;
    expect(current!.connection_lease_expires_at).toEqual(future!.connection_lease_expires_at);
    // Native SQL admits infinity and dates beyond Date's upper bound. The former
    // Date comparison did not preserve these as longer leases.
    for (const expiry of [
      "infinity",
      "-infinity",
      "280000-01-01 00:00:00+00",
      "275760-09-13 00:00:00.001+00",
    ]) {
      await admin`update enrollments set connection_lease_expires_at=${expiry}::text::timestamptz
        where id=${box.id}`;
      expect(await renewSandboxAgentLink(db, link)).toEqual({ renewed: true });
      const [finite] = await admin`select isfinite(connection_lease_expires_at) as finite,
        extract(epoch from connection_lease_expires_at-updated_at)*1000 as duration_ms
        from enrollments where id=${box.id}`;
      expect(finite!.finite).toBe(true);
      expect(Number(finite!.duration_ms)).toBe(LEASE_MS);
    }
    await admin`update enrollments set connection_lease_expires_at='275760-09-13 00:00:00.000999+00'::timestamptz
      where id=${box.id}`;
    expect(await renewSandboxAgentLink(db, link)).toEqual({ renewed: true });
    const [lastDate] =
      await admin`select connection_lease_expires_at = '275760-09-13 00:00:00+00'::timestamptz as kept
      from enrollments where id=${box.id}`;
    expect(lastDate!.kept).toBe(true);
    // A null recorded epoch and a higher offered epoch retain the old semantics.
    await admin`update enrollments set link_epoch=null where id=${box.id}`;
    expect(await renewSandboxAgentLink(db, link)).toEqual({ renewed: true });
    await admin`update enrollments set link_epoch=1 where id=${box.id}`;
    expect(await renewSandboxAgentLink(db, { ...link, epoch: 2 })).toEqual({ renewed: true });
    expect(
      await renewSandboxAgentLink(db, { ...link, connectionInstanceId: crypto.randomUUID() }),
    ).toEqual({ renewed: false, code: "lost" });
    await admin`update enrollments set link_epoch=2 where id=${box.id}`;
    expect(
      await renewSandboxAgentLink(db, { ...link, connectionInstanceId: crypto.randomUUID() }),
    ).toEqual({ renewed: false, code: "superseded" });
    await admin`update enrollments set status='revoked' where id=${box.id}`;
    expect(await renewSandboxAgentLink(db, link)).toEqual({ renewed: false, code: "revoked" });
    expect(await renewSandboxAgentLink(db, { ...link, agentId: crypto.randomUUID() })).toEqual({
      renewed: false,
      code: "revoked",
    });
    const other = await freshWorkspace();
    expect(await renewSandboxAgentLink(db, { ...link, workspaceId: other.workspaceId })).toEqual({
      renewed: false,
      code: "revoked",
    });
  });

  test("a batched renewal answers each claim as a single renewal would", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const other = await freshWorkspace();
    const boxes = await Promise.all(Array.from({ length: 6 }, () => sandboxEnrollment(ws)));
    const foreign = await sandboxEnrollment(other);
    const instances = boxes.map(() => crypto.randomUUID());
    for (const [index, box] of boxes.entries()) {
      await openSandboxAgentLink(db, {
        workspaceId: ws.workspaceId,
        agentId: box.id,
        epoch: 2,
        connectionInstanceId: instances[index]!,
        leaseMs: LEASE_MS,
      });
    }
    await openSandboxAgentLink(db, {
      workspaceId: other.workspaceId,
      agentId: foreign.id,
      epoch: 1,
      connectionInstanceId: crypto.randomUUID(),
      leaseMs: LEASE_MS,
    });
    // 0 renews; 1 was superseded; 2 lost its claim; 3 was revoked; 4 keeps a
    // longer lease; 5 has no recorded epoch.
    await admin`update enrollments set link_epoch=3 where id=${boxes[1]!.id}`;
    await admin`update enrollments set connection_instance_id=${crypto.randomUUID()} where id=${boxes[2]!.id}`;
    await admin`update enrollments set status='revoked' where id=${boxes[3]!.id}`;
    const [long] = await admin`update enrollments set
      connection_lease_expires_at = date_trunc('milliseconds',clock_timestamp()) + interval '1 hour'
      where id=${boxes[4]!.id} returning connection_lease_expires_at`;
    await admin`update enrollments set link_epoch=null where id=${boxes[5]!.id}`;
    const before = await admin<{ id: string; expires: Date }[]>`
      select id, connection_lease_expires_at as expires from enrollments
      where id in ${admin(boxes.map((box) => box.id))}`;
    const claims = [
      ...boxes.map((box, index) => ({
        agentId: box.id,
        epoch: 2,
        connectionInstanceId: instances[index]!,
      })),
      // Unknown, and another workspace's agent (hidden by RLS): both revoked.
      { agentId: crypto.randomUUID(), epoch: 2, connectionInstanceId: crypto.randomUUID() },
      { agentId: foreign.id, epoch: 1, connectionInstanceId: crypto.randomUUID() },
    ];
    // Results follow the order of the claims, not of the locks.
    const reversed = [...claims].reverse();
    const results = await renewSandboxAgentLinks(db, {
      workspaceId: ws.workspaceId,
      leaseMs: LEASE_MS,
      claims: reversed,
    });
    expect(results.reverse()).toEqual([
      { renewed: true },
      { renewed: false, code: "superseded" },
      { renewed: false, code: "lost" },
      { renewed: false, code: "revoked" },
      { renewed: true },
      { renewed: true },
      { renewed: false, code: "revoked" },
      { renewed: false, code: "revoked" },
    ]);
    const after = new Map(
      (
        await admin<{ id: string; expires: Date; duration_ms: string }[]>`
          select id, connection_lease_expires_at as expires,
            extract(epoch from connection_lease_expires_at - updated_at) * 1000 as duration_ms
          from enrollments where id in ${admin(boxes.map((box) => box.id))}`
      ).map((row) => [row.id, row]),
    );
    const beforeById = new Map(before.map((row) => [row.id, row.expires]));
    expect(Number(after.get(boxes[0]!.id)!.duration_ms)).toBe(LEASE_MS);
    expect(Number(after.get(boxes[5]!.id)!.duration_ms)).toBe(LEASE_MS);
    expect(after.get(boxes[4]!.id)!.expires).toEqual(long!.connection_lease_expires_at);
    for (const refused of [1, 2, 3]) {
      expect(after.get(boxes[refused]!.id)!.expires).toEqual(beforeById.get(boxes[refused]!.id)!);
    }
    // The foreign workspace's claim was not touched.
    const [foreignRow] =
      await admin`select connection_instance_id from enrollments where id=${foreign.id}`;
    expect(foreignRow!.connection_instance_id).not.toBeNull();
    expect(
      await renewSandboxAgentLinks(db, {
        workspaceId: ws.workspaceId,
        leaseMs: LEASE_MS,
        claims: [],
      }),
    ).toEqual([]);
    await expect(
      renewSandboxAgentLinks(db, {
        workspaceId: ws.workspaceId,
        leaseMs: LEASE_MS,
        claims: [claims[0]!, claims[0]!],
      }),
    ).rejects.toThrow("names an agent twice");
  });

  test("a batched renewal is one statement, and overlapping batches never deadlock", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const count = 120;
    const boxes = await Promise.all(Array.from({ length: count }, () => sandboxEnrollment(ws)));
    const claims = boxes.map((box) => ({
      agentId: box.id,
      epoch: 1,
      connectionInstanceId: crypto.randomUUID(),
    }));
    for (const claim of claims) {
      await openSandboxAgentLink(db, { ...claim, workspaceId: ws.workspaceId, leaseMs: LEASE_MS });
    }
    const statements: string[] = [];
    const measured = createDb(shared!.appUrl, { max: 1 });
    const driver = (measured.db as unknown as { $client: postgres.Sql }).$client;
    driver.options.debug = (_connection, query) => {
      statements.push(query);
    };
    try {
      const results = await renewSandboxAgentLinks(measured.db, {
        workspaceId: ws.workspaceId,
        leaseMs: LEASE_MS,
        claims,
      });
      expect(results.every((result) => result.renewed)).toBe(true);
      expect(statements.filter((query) => /from enrollments/i.test(query))).toHaveLength(1);
      statements.length = 0;
      for (const claim of claims) {
        await renewSandboxAgentLink(measured.db, {
          ...claim,
          workspaceId: ws.workspaceId,
          leaseMs: LEASE_MS,
        });
      }
      expect(statements.filter((query) => /from enrollments/i.test(query))).toHaveLength(count);
    } finally {
      await measured.close();
    }
    // Two replicas renewing overlapping sets in opposite orders both finish;
    // a row the other batch holds at that moment is only busy, never refused.
    const forward = renewSandboxAgentLinks(db, {
      workspaceId: ws.workspaceId,
      leaseMs: LEASE_MS,
      claims,
    });
    const backward = renewSandboxAgentLinks(db, {
      workspaceId: ws.workspaceId,
      leaseMs: LEASE_MS,
      claims: [...claims].reverse(),
    });
    const [a, b] = await Promise.all([forward, backward]);
    for (const result of [...a, ...b]) {
      expect(result.renewed || "busy" in result).toBe(true);
    }
  });

  test("a batched renewal skips a held row as busy, renews the rest at once, and samples the clock after locking", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const boxes = await Promise.all(Array.from({ length: 5 }, () => sandboxEnrollment(ws)));
    const claims = boxes.map((box) => ({
      agentId: box.id,
      epoch: 1,
      connectionInstanceId: crypto.randomUUID(),
    }));
    for (const claim of claims) {
      await openSandboxAgentLink(db, { ...claim, workspaceId: ws.workspaceId, leaseMs: LEASE_MS });
    }
    const held = boxes[2]!.id;
    const [heldBefore] =
      await admin`select connection_lease_expires_at from enrollments where id=${held}`;
    let unlock!: () => void;
    let signalLocked!: () => void;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const holder = admin.begin(async (tx) => {
      await tx`select id from enrollments where id=${held} for update`;
      signalLocked();
      await gate;
    });
    await locked;
    let results: Awaited<ReturnType<typeof renewSandboxAgentLinks>>;
    try {
      // Before skip-locked, the batch waited here for the holder and held the
      // rows it had already locked; now it answers while the lock is held.
      results = await Promise.race([
        renewSandboxAgentLinks(db, { workspaceId: ws.workspaceId, leaseMs: LEASE_MS, claims }),
        Bun.sleep(3_000).then(() => {
          throw new Error("the batch waited on a held row");
        }),
      ]);
      const [lockTime] = await admin`select clock_timestamp() as now`;
      const rows = await admin`select id, updated_at from enrollments where id in ${admin(
        boxes.map((box) => box.id),
      )}`;
      for (const row of rows) {
        if (row.id === held) continue;
        expect(row.updated_at.getTime()).toBeLessThanOrEqual(lockTime!.now.getTime());
      }
    } finally {
      unlock();
      await holder;
    }
    expect(results).toEqual([
      { renewed: true },
      { renewed: true },
      { renewed: false, busy: true },
      { renewed: true },
      { renewed: true },
    ]);
    const [heldAfter] =
      await admin`select connection_lease_expires_at from enrollments where id=${held}`;
    expect(heldAfter!.connection_lease_expires_at).toEqual(heldBefore!.connection_lease_expires_at);
    // Once the holder is gone the next batch renews it, answered by position
    // even when the caller spells the id in capitals.
    const again = await renewSandboxAgentLinks(db, {
      workspaceId: ws.workspaceId,
      leaseMs: LEASE_MS,
      claims: [{ ...claims[2]!, agentId: held.toUpperCase() }, claims[0]!],
    });
    expect(again).toEqual([{ renewed: true }, { renewed: true }]);
    await expect(
      renewSandboxAgentLinks(db, {
        workspaceId: ws.workspaceId,
        leaseMs: LEASE_MS,
        claims: [claims[0]!, { ...claims[0]!, agentId: claims[0]!.agentId.toUpperCase() }],
      }),
    ).rejects.toThrow("names an agent twice");
  });

  test("renewal samples the clock after locking and sees committed ownership changes", async () => {
    if (!available) return;
    for (const change of ["clock", "superseded", "revoked", "lost"] as const) {
      const ws = await freshWorkspace();
      const box = await sandboxEnrollment(ws);
      const link = {
        workspaceId: ws.workspaceId,
        agentId: box.id,
        epoch: 1,
        connectionInstanceId: crypto.randomUUID(),
        leaseMs: LEASE_MS,
      };
      await openSandboxAgentLink(db, link);
      let unlock!: () => void;
      let signalLocked!: () => void;
      const gate = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      let releasedAt: Date | undefined;
      const holder = admin.begin(async (tx) => {
        await tx`select id from enrollments where id=${box.id} for update`;
        if (change === "superseded")
          await tx`update enrollments set link_epoch=2 where id=${box.id}`;
        if (change === "revoked")
          await tx`update enrollments set status='revoked' where id=${box.id}`;
        if (change === "lost")
          await tx`update enrollments set connection_instance_id=${crypto.randomUUID()} where id=${box.id}`;
        signalLocked();
        await gate;
        const [clock] = await tx`select clock_timestamp() as now`;
        releasedAt = clock!.now;
      });
      await locked;
      const renewal = renewSandboxAgentLink(db, link);
      try {
        let waiting = false;
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          const [row] = await admin`select exists(select 1 from pg_stat_activity
            where datname=current_database() and usename='opengeni_app' and wait_event_type='Lock'
              and query ilike '%enrollments%') as waiting`;
          if (row!.waiting) {
            waiting = true;
            break;
          }
          await Bun.sleep(10);
        }
        expect(waiting).toBe(true);
        // Make a pre-lock clock observably too early rather than relying on timing noise.
        await Bun.sleep(50);
      } finally {
        unlock();
      }
      await holder;
      const outcome = await renewal;
      if (change !== "clock") {
        expect(outcome).toEqual({ renewed: false, code: change });
      } else {
        expect(outcome).toEqual({ renewed: true });
        const [row] =
          await admin`select updated_at,connection_lease_expires_at from enrollments where id=${box.id}`;
        expect(row!.updated_at.getTime()).toBeGreaterThanOrEqual(releasedAt!.getTime());
        expect(row!.connection_lease_expires_at.getTime() - row!.updated_at.getTime()).toBe(
          LEASE_MS,
        );
      }
    }
  }, 15_000);

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
