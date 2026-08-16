// M7 — the FLEET service backing the fleet MCP tools (list/attach/swap/run_on/
// provision), driven against the REAL packages/db on a THROWAWAY postgres (mirrors
// enrollment-routes / sandbox-resume). The selfhosted control plane is an in-memory
// MemoryEventBus responder decoding ControlRequest -> ControlResponse (a stand-in
// for an enrolled agent over NATS), so liveness probes + run_on exercise the real
// SelfhostedSession path with zero broker.
//
// Proves:
//   - sandboxes_list: the session's Modal box + the enrolled machine, each with
//     liveness + an `active` marker.
//   - attach/swap: the epoch-fenced CAS flips active_sandbox_id + bumps active_epoch.
//   - heterogeneous swap (>=2 flips): Modal->machine->Modal->machine, single-active.
//   - single-active invariant: never two `active` entries at once.
//   - swap to an OFFLINE machine is rejected (liveness gate).
//   - run_on routes a one-off exec to a specific machine WITHOUT moving the pointer.
//   - provision: selfhosted -> enrollment instructions; modal -> a named record.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  testSettings,
  MemoryEventBus,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { ControlRequest, ControlResponse, ErrorCode } from "@opengeni/agent-proto";
import {
  createDb,
  createEnrollment,
  createSandbox,
  createSession,
  getEnrollment,
  getLiveEnrollmentConnection,
  claimEnrollmentConnection,
  readActiveSandbox,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { subjectFor } from "@opengeni/runtime";
import {
  listFleet,
  provisionSandbox,
  runOnSandbox,
  swapActiveSandbox,
  type FleetContext,
  type FleetServices,
} from "@opengeni/core";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
const CONNECTION_INSTANCE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const settings = testSettings({
  productAccessMode: "managed",
  sandboxSelfhostedEnabled: true,
  // This fixture intentionally implements only the finite legacy request/reply
  // protocol. Production's unbounded default requires the resumable op stream.
  agentOpStreamEnabled: false,
  sandboxSelfhostedExecTimeoutMs: 30_000,
  selfhostedRelayUrl: "wss://relay.example",
  publicBaseUrl: "https://app.example",
});

/** A MemoryEventBus whose responder, registered on the machine's agent subject,
 *  answers ping/exec/fsRead/fsWrite from an in-memory FS — an in-process stand-in
 *  for a real enrolled agent over NATS. `online=false` registers NO responder
 *  (the subject 503s → offline). */
function busWithAgent(opts: {
  workspaceId: string;
  agentId: string;
  online: boolean;
  hostname?: string;
}): MemoryEventBus {
  const bus = new MemoryEventBus();
  if (!opts.online) {
    return bus;
  }
  const files = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  bus.subscribeRequests(
    subjectFor(opts.workspaceId, opts.agentId, CONNECTION_INSTANCE_ID),
    (payload) => {
      const req = ControlRequest.decode(payload);
      const op = req.op;
      let res: ControlResponse;
      if (op?.$case === "ping") {
        res = {
          requestId: req.requestId,
          result: {
            $case: "ping",
            ping: { nonce: op.ping.nonce, agentMonotonicMs: "0" },
          },
        };
      } else if (op?.$case === "exec") {
        const joined = op.exec.command.join(" ");
        const stdout = /HOSTNAME|hostname/.test(joined) ? (opts.hostname ?? "the-machine") : joined;
        res = {
          requestId: req.requestId,
          result: {
            $case: "exec",
            exec: {
              exitCode: 0,
              stdout: enc.encode(`${stdout}\n`),
              stderr: new Uint8Array(0),
              timedOut: false,
              durationMs: "1",
            },
          },
        };
      } else if (op?.$case === "fsWrite") {
        files.set(op.fsWrite.path, op.fsWrite.content);
        res = {
          requestId: req.requestId,
          result: {
            $case: "fsWrite",
            fsWrite: { bytesWritten: String(op.fsWrite.content.length) },
          },
        };
      } else if (op?.$case === "fsRead") {
        const bytes = files.get(op.fsRead.path);
        res = bytes
          ? {
              requestId: req.requestId,
              result: {
                $case: "fsRead",
                fsRead: { content: bytes, totalSize: String(bytes.length) },
              },
            }
          : {
              requestId: req.requestId,
              error: {
                code: ErrorCode.ERROR_CODE_NOT_FOUND,
                message: "no such file",
                retryable: false,
                detail: {},
              },
            };
      } else {
        res = {
          requestId: req.requestId,
          error: {
            code: ErrorCode.ERROR_CODE_UNSUPPORTED,
            message: "unsupported",
            retryable: false,
            detail: {},
          },
        };
      }
      return ControlResponse.encode(res).finish();
    },
  );
  return bus;
}

async function freshWorkspace(): Promise<{
  accountId: string;
  workspaceId: string;
}> {
  const [a] = await admin<
    { id: string }[]
  >`insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id };
}

/** Seed a session (Modal group box) + an enrolled selfhosted machine + its sandbox
 *  record, and return the fleet context for the session. */
async function seedFleet(
  opts: {
    online?: boolean;
    hostname?: string;
    sandboxBackend?: "modal" | "none";
  } = {},
) {
  const { accountId, workspaceId } = await freshWorkspace();
  const session = await createSession(db, {
    accountId,
    workspaceId,
    initialMessage: "hi",
    resources: [],
    metadata: {},
    model: "gpt-test",
    sandboxBackend: opts.sandboxBackend ?? "modal",
  });
  const enrollment = await createEnrollment(db, {
    accountId,
    workspaceId,
    pubkey: `ed25519:${crypto.randomUUID()}`,
    exposure: "whole-machine",
    hasDisplay: true,
    allowScreenControl: true,
    os: "linux",
    arch: "x86_64",
  });
  const connection = await claimEnrollmentConnection(db, {
    workspaceId,
    enrollmentId: enrollment.id,
    credentialGeneration: enrollment.credentialGeneration,
    connectionInstanceId: CONNECTION_INSTANCE_ID,
    leaseMs: 60_000,
  });
  expect(connection.claimed).toBe(true);
  // Stamp lastSeenAt recent so a probe-miss would be "reconnecting", but our online
  // responder makes the probe succeed → online.
  await admin`update enrollments set last_seen_at = now() where id = ${enrollment.id}`;
  const sandbox = await createSandbox(db, {
    accountId,
    workspaceId,
    kind: "selfhosted",
    name: "my-laptop",
    enrollmentId: enrollment.id,
  });
  const ctx: FleetContext = {
    accountId,
    workspaceId,
    sessionId: session.id,
    sessionBackend: opts.sandboxBackend ?? "modal",
    sessionGroupId: session.sandboxGroupId,
  };
  const services: FleetServices = {
    db,
    settings,
    bus: busWithAgent({
      workspaceId,
      agentId: enrollment.id,
      online: opts.online ?? true,
      hostname: opts.hostname,
    }) as never,
  };
  return {
    ctx,
    services,
    session,
    enrollment,
    sandbox,
    accountId,
    workspaceId,
  };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("fleet-tools");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[fleet-tools] docker unavailable, skipping");
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

describe("M7 fleet service — list / attach / swap / run_on / provision", () => {
  test("a personal Connected Machine remains operational from another authorized workspace", async () => {
    if (!available) return;
    const subjectId = `human:${crypto.randomUUID()}`;
    const [account] = await admin<Array<{ id: string }>>`
      insert into managed_accounts (name) values (${`cross-workspace-${crypto.randomUUID()}`})
      returning id
    `;
    const workspaces = await Promise.all(
      ["personal", "origin", "target"].map(async (name) => {
        const [workspace] = await admin<Array<{ id: string }>>`
          insert into workspaces (account_id, name) values (${account!.id}, ${name})
          returning id
        `;
        return workspace!;
      }),
    );
    const [personalWorkspace, originWorkspace, targetWorkspace] = workspaces;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id) values
        (${personalWorkspace!.id}, ${account!.id}),
        (${originWorkspace!.id}, ${account!.id}),
        (${targetWorkspace!.id}, ${account!.id})
    `;
    await admin`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id, authorization_revision
      ) values (${account!.id}, ${subjectId}, 'active', ${personalWorkspace!.id}, 1)
    `;
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id) values
        (${account!.id}, ${originWorkspace!.id}, ${subjectId}),
        (${account!.id}, ${targetWorkspace!.id}, ${subjectId})
    `;
    const machine = await admin.begin(async (tx) => {
      await tx`select
        set_config('opengeni.account_id', ${account!.id}, true),
        set_config('opengeni.workspace_id', ${originWorkspace!.id}, true),
        set_config('opengeni.subject_id', ${subjectId}, true),
        set_config('opengeni.initiating_human_subject_id', ${subjectId}, true)`;
      const [row] = await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
        select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
        from finalize_scoped_enrollment(
          ${account!.id}::uuid, ${originWorkspace!.id}::uuid, 'user',
          ${`ed25519:${crypto.randomUUID()}`}, true, true, 'linux', 'x86_64',
          'Personal laptop', false
        )
      `;
      return row!;
    });
    const connectionInstanceId = CONNECTION_INSTANCE_ID;
    const enrollment = await getEnrollment(db, originWorkspace!.id, machine.enrollmentId);
    expect(enrollment).not.toBeNull();
    expect(
      (
        await claimEnrollmentConnection(db, {
          workspaceId: originWorkspace!.id,
          enrollmentId: machine.enrollmentId,
          credentialGeneration: enrollment!.credentialGeneration,
          connectionInstanceId,
          leaseMs: 60_000,
        })
      ).claimed,
    ).toBe(true);
    await admin`update enrollments set last_seen_at = now() where id = ${machine.enrollmentId}`;
    const session = await createSession(db, {
      accountId: account!.id,
      workspaceId: targetWorkspace!.id,
      initialMessage: "use my personal laptop",
      resources: [],
      metadata: {},
      model: "gpt-test",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId },
      subjectId,
    });
    const [machineAuthority] = await admin<Array<{ id: string }>>`
      select id from organization_user_resource_authorities
      where account_id = ${account!.id} and resource_kind = 'connected_machine'
        and resource_id = ${machine.enrollmentId}
    `;
    const [sessionAuthority] = await admin<
      Array<{ authorityEpoch: number; visibility: "user_private" | "workspace_shared" }>
    >`
      select authority_epoch as "authorityEpoch", visibility
      from sessions where id = ${session.id}
    `;
    await admin.begin(async (tx) => {
      await tx`select
        set_config('opengeni.account_id', ${account!.id}, true),
        set_config('opengeni.workspace_id', ${targetWorkspace!.id}, true),
        set_config('opengeni.subject_id', ${subjectId}, true)`;
      await tx`
        select grant_id from issue_self_user_resource_grant(
          ${account!.id}::uuid, ${machineAuthority!.id}::uuid,
          ${targetWorkspace!.id}::uuid, 'connected_machine.use', 'session',
          ${sessionAuthority!.visibility}, ${session.id}::uuid, true
        )
      `;
    });
    const executionGeneration = 1;
    const [turn] = await admin<Array<{ id: string }>>`
      insert into session_turns (
        account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, position, prompt, model, reasoning_effort, sandbox_backend,
        execution_generation, initiator_kind, initiator_subject_id,
        initiating_human_subject_id
      ) values (
        ${account!.id}, ${targetWorkspace!.id}, ${session.id}, gen_random_uuid(),
        ${`fleet-${crypto.randomUUID()}`}, 'running', 0, 'use personal machine',
        'gpt-test', 'medium', 'none', ${executionGeneration}, 'subject', ${subjectId},
        ${subjectId}
      ) returning id
    `;
    const attemptId = crypto.randomUUID();
    await admin.begin(async (tx) => {
      await tx.unsafe("set local opengeni.session_inference_claim = '1'");
      await tx`
        update sessions set active_turn_id = ${turn!.id}, status = 'running'
        where id = ${session.id}
      `;
      await tx`
        update session_turns set active_attempt_id = ${attemptId}, status = 'running'
        where id = ${turn!.id}
      `;
      await tx`
        insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
          verified_control_revision, authority_epoch, authority_visibility,
          mcp_approval_policies, connector_action_policies
        ) values (
          ${attemptId}, ${account!.id}, ${targetWorkspace!.id}, ${session.id}, ${turn!.id},
          ${executionGeneration}, 'running', 'fleet-workflow', ${`run-${attemptId}`},
          ${`activity-${attemptId}`}, 0, ${sessionAuthority!.authorityEpoch},
          ${sessionAuthority!.visibility}, '{}'::jsonb, '[]'::jsonb
        )
      `;
    });
    const ctx: FleetContext = {
      accountId: account!.id,
      workspaceId: targetWorkspace!.id,
      subjectId,
      sessionId: session.id,
      sessionBackend: "none",
      sessionGroupId: session.sandboxGroupId,
      attemptAuthority: {
        turnId: turn!.id,
        attemptId,
        executionGeneration,
        initiatingHumanSubjectId: subjectId,
      },
    };
    const services: FleetServices = {
      db,
      settings,
      bus: busWithAgent({
        workspaceId: originWorkspace!.id,
        agentId: machine.enrollmentId,
        online: true,
        hostname: "personal-cross-workspace",
      }) as never,
    };
    const withoutAttempt: FleetContext = {
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      subjectId: ctx.subjectId,
      sessionId: ctx.sessionId,
      sessionBackend: ctx.sessionBackend,
      sessionGroupId: ctx.sessionGroupId,
    };
    expect(
      (
        await runOnSandbox(services, withoutAttempt, machine.sandboxId, {
          kind: "exec",
          cmd: "hostname",
        })
      ).ok,
    ).toBe(false);
    expect((await swapActiveSandbox(services, withoutAttempt, machine.sandboxId)).swapped).toBe(
      false,
    );

    expect(
      (
        await getLiveEnrollmentConnection(
          db,
          {
            accountId: account!.id,
            workspaceId: targetWorkspace!.id,
            subjectId,
          },
          machine.enrollmentId,
        )
      )?.connectionInstanceId,
    ).toBe(connectionInstanceId);
    const listed = await listFleet(services, ctx);
    expect(listed.sandboxes[0]?.liveness).toBe("online");
    expect(listed.sandboxes.map((sandbox) => sandbox.id)).toEqual([machine.sandboxId]);
    const swapped = await swapActiveSandbox(services, ctx, machine.sandboxId);
    expect(swapped).toMatchObject({
      swapped: true,
      activeSandboxId: machine.sandboxId,
    });
    const executed = await runOnSandbox(services, ctx, machine.sandboxId, {
      kind: "exec",
      cmd: "hostname",
    });
    expect(executed).toMatchObject({
      ok: true,
      stdout: "personal-cross-workspace\n",
    });
  }, 60_000);

  test("a backend:none session lists and attaches an owned Connected Machine without inventing a home box", async () => {
    if (!available) return;
    const { ctx, services, sandbox } = await seedFleet({
      sandboxBackend: "none",
    });

    const before = await listFleet(services, ctx);
    expect(before.activeSandboxId).toBeNull();
    expect(before.sandboxes).toHaveLength(1);
    expect(before.sandboxes[0]?.id).toBe(sandbox.id);
    expect(before.sandboxes[0]?.active).toBe(false);

    const attached = await swapActiveSandbox(services, ctx, sandbox.id);
    expect(attached.swapped).toBe(true);
    expect(attached.activeSandboxId).toBe(sandbox.id);

    const noHome = await swapActiveSandbox(services, ctx, "session");
    expect(noHome.swapped).toBe(false);
    expect(noHome.code).toBe("unsupported_backend_context");
    expect((await readActiveSandbox(db, ctx.workspaceId, ctx.sessionId))?.activeSandboxId).toBe(
      sandbox.id,
    );
  }, 60_000);

  test("sandboxes_list: the session Modal box + the enrolled machine, each with liveness + active marker", async () => {
    if (!available) return;
    const { ctx, services, session, sandbox } = await seedFleet({
      hostname: "vm-list",
    });
    const result = await listFleet(services, ctx);

    // Default pointer (null) → the group box is active.
    expect(result.activeSandboxId).toBeNull();
    expect(result.sandboxes.length).toBe(2);

    const group = result.sandboxes.find((s) => s.isSessionGroup)!;
    expect(group.id).toBe(session.sandboxGroupId);
    expect(group.kind).toBe("modal");
    expect(group.active).toBe(true);
    // A session row without a materialized/verified provider is not online.
    expect(group.liveness).toBe("offline");
    expect(group.attachable).toBe(false);
    expect(group.operationAvailability).toBe("wakeable");
    expect(group.providerStatus).toBe("not_created");
    expect(group.leaseLiveness).toBeNull();
    expect(group.routeStatus).toBe("attached");
    expect(group.workspaceStatus).toBe("unknown");

    const machine = result.sandboxes.find((s) => !s.isSessionGroup)!;
    expect(machine.id).toBe(sandbox.id);
    expect(machine.kind).toBe("selfhosted");
    expect(machine.active).toBe(false);
    expect(machine.liveness).toBe("online"); // the in-memory agent answered the ping
    expect(machine.consented).toBe(true);
    expect(machine.hasDisplay).toBe(true);
    expect(machine.attachable).toBe(true);
    expect(machine.operationAvailability).toBe("ready");

    // Single-active invariant: exactly ONE active entry.
    expect(result.sandboxes.filter((s) => s.active).length).toBe(1);
  }, 60_000);

  test("a holderless draining Modal home is explicitly wakeable, not unavailable", async () => {
    if (!available) return;
    const { ctx, services, accountId, workspaceId } = await seedFleet();
    await admin`
      insert into sandbox_leases (
        account_id,
        workspace_id,
        sandbox_group_id,
        liveness,
        instance_id,
        backend,
        lease_epoch,
        workspace_generation,
        archive_generation,
        resume_state,
        expires_at
      ) values (
        ${accountId},
        ${workspaceId},
        ${ctx.sessionGroupId},
        'draining',
        'sb-idle-home',
        'modal',
        7,
        12,
        12,
        ${admin.json({
          opengeniRecovery: {
            provider: {
              status: "exists",
              instanceId: "sb-idle-home",
              observedAt: "2026-08-05T16:30:00.000Z",
            },
            archive: { status: "none", current: null, previous: null },
            restore: {
              status: "not_required",
              rematerializationId: null,
              selectedRevision: null,
              startedAt: null,
              completedAt: null,
            },
            workspace: {
              status: "ready",
              verifiedRevision: "idle-home-ready",
              verifiedAt: "2026-08-05T16:30:00.000Z",
            },
          },
        })}::jsonb,
        now() + interval '15 minutes'
      )
    `;

    const result = await listFleet(services, ctx);
    const group = result.sandboxes.find((sandbox) => sandbox.isSessionGroup)!;
    expect(group.liveness).toBe("offline");
    expect(group.leaseLiveness).toBe("draining");
    expect(group.attachable).toBe(false);
    expect(group.operationAvailability).toBe("wakeable");
    expect(group.providerStatus).toBe("exists");
    expect(group.workspaceStatus).toBe("ready");
  }, 60_000);

  test("attach/swap: the epoch-fenced CAS flips active_sandbox_id + bumps active_epoch", async () => {
    if (!available) return;
    const { ctx, services, sandbox } = await seedFleet();

    const before = (await readActiveSandbox(db, ctx.workspaceId, ctx.sessionId))!;
    expect(before.activeSandboxId).toBeNull();

    const swap = await swapActiveSandbox(services, ctx, sandbox.id);
    expect(swap.swapped).toBe(true);
    expect(swap.activeSandboxId).toBe(sandbox.id);
    expect(swap.activeEpoch).toBe(before.activeEpoch + 1);

    // The pointer is persisted; a list now marks the machine active (single-active).
    const list = await listFleet(services, ctx);
    expect(list.activeSandboxId).toBe(sandbox.id);
    expect(list.sandboxes.find((s) => s.id === sandbox.id)!.active).toBe(true);
    expect(list.sandboxes.filter((s) => s.active).length).toBe(1);

    // Swap back to the session's own box (target "session" → null pointer).
    const back = await swapActiveSandbox(services, ctx, "session");
    expect(back.swapped).toBe(true);
    expect(back.activeSandboxId).toBeNull();
    expect(back.activeEpoch).toBe(swap.activeEpoch + 1);
  }, 60_000);

  test("same-target attach is a readiness repair that advances the route epoch or fails typed", async () => {
    if (!available) return;
    const { ctx, services } = await seedFleet();
    const before = (await readActiveSandbox(db, ctx.workspaceId, ctx.sessionId))!;
    let readinessChecks = 0;
    let releases = 0;
    let pointerObservedAtRelease: Awaited<ReturnType<typeof readActiveSandbox>> = null;
    const repaired = await swapActiveSandbox(
      {
        ...services,
        ensureSessionGroupReady: async () => {
          readinessChecks += 1;
          return {
            release: async () => {
              pointerObservedAtRelease = await readActiveSandbox(
                db,
                ctx.workspaceId,
                ctx.sessionId,
              );
              releases += 1;
            },
          };
        },
      },
      ctx,
      "session",
    );
    expect(repaired.swapped).toBe(true);
    expect(repaired.activeSandboxId).toBeNull();
    expect(repaired.activeEpoch).toBe(before.activeEpoch + 1);
    expect(readinessChecks).toBe(1);
    expect(releases).toBe(1);
    expect(pointerObservedAtRelease?.activeEpoch).toBe(repaired.activeEpoch);

    const rejectedBefore = (await readActiveSandbox(db, ctx.workspaceId, ctx.sessionId))!;
    const rejected = await swapActiveSandbox(
      {
        ...services,
        ensureSessionGroupReady: async () => {
          throw new Error("restore is still verifying");
        },
      },
      ctx,
      "session",
    );
    expect(rejected.swapped).toBe(false);
    expect(rejected.code).toBe("recovery_in_progress");
    expect(rejected.activeEpoch).toBe(rejectedBefore.activeEpoch);

    let failedRelease = 0;
    const failed = await swapActiveSandbox(
      {
        ...services,
        ensureSessionGroupReady: async () => ({
          release: async () => {
            failedRelease += 1;
          },
        }),
      },
      { ...ctx, accountId: crypto.randomUUID() },
      "session",
    );
    expect(failed.swapped).toBe(false);
    expect(failed.code).toBe("concurrent_swap");
    expect(failedRelease).toBe(1);
  }, 60_000);

  test("heterogeneous swap (>=2 flips): Modal->machine->Modal->machine, single-active each time", async () => {
    if (!available) return;
    const { ctx, services, sandbox } = await seedFleet();

    const epochs: number[] = [];
    // Flip 1: -> machine.
    let r = await swapActiveSandbox(services, ctx, sandbox.id);
    expect(r.activeSandboxId).toBe(sandbox.id);
    epochs.push(r.activeEpoch);
    // Flip 2: -> session box.
    r = await swapActiveSandbox(services, ctx, "session");
    expect(r.activeSandboxId).toBeNull();
    epochs.push(r.activeEpoch);
    // Flip 3: -> machine again.
    r = await swapActiveSandbox(services, ctx, sandbox.id);
    expect(r.activeSandboxId).toBe(sandbox.id);
    epochs.push(r.activeEpoch);

    // Each flip bumped the epoch monotonically (the fence advanced every time).
    expect(epochs).toEqual([1, 2, 3]);

    // After the flips the machine is the single active entry.
    const list = await listFleet(services, ctx);
    expect(list.sandboxes.filter((s) => s.active).length).toBe(1);
    expect(list.sandboxes.find((s) => s.id === sandbox.id)!.active).toBe(true);
  }, 60_000);

  test("swap to an OFFLINE machine is rejected (liveness gate), pointer unchanged", async () => {
    if (!available) return;
    // Seed with NO responder → the machine probes offline.
    const { ctx, services, sandbox } = await seedFleet({ online: false });
    const r = await swapActiveSandbox(services, ctx, sandbox.id);
    expect(r.swapped).toBe(false);
    expect(r.reason).toMatch(/offline|non-online/i);
    // The pointer never moved.
    const pointer = (await readActiveSandbox(db, ctx.workspaceId, ctx.sessionId))!;
    expect(pointer.activeSandboxId).toBeNull();
  }, 60_000);

  test("run_on: a one-off exec routes to a specific machine WITHOUT moving the active pointer", async () => {
    if (!available) return;
    const { ctx, services, sandbox } = await seedFleet({
      hostname: "runon-vm",
    });
    const before = (await readActiveSandbox(db, ctx.workspaceId, ctx.sessionId))!;

    const exec = await runOnSandbox(services, ctx, sandbox.id, {
      kind: "exec",
      cmd: "echo $HOSTNAME",
    });
    expect(exec.ok).toBe(true);
    expect(exec.stdout?.trim()).toBe("runon-vm");
    expect(exec.exitCode).toBe(0);
    expect(exec.timedOut).toBe(false);
    expect(exec.deadlineMs).toBe(settings.sandboxSelfhostedExecTimeoutMs);

    // The active pointer is UNCHANGED (run_on is a side-channel, not a swap).
    const after = (await readActiveSandbox(db, ctx.workspaceId, ctx.sessionId))!;
    expect(after.activeSandboxId).toBe(before.activeSandboxId);
    expect(after.activeEpoch).toBe(before.activeEpoch);

    // run_on write -> read round-trips on the machine.
    const wrote = await runOnSandbox(services, ctx, sandbox.id, {
      kind: "write",
      path: "/tmp/marker",
      content: "hello",
    });
    expect(wrote.ok).toBe(true);
    const read = await runOnSandbox(services, ctx, sandbox.id, {
      kind: "read",
      path: "/tmp/marker",
    });
    expect(read.ok).toBe(true);
    expect(read.content).toBe("hello");
  }, 60_000);

  test("run_on a modal/group target is rejected (run_on is for non-active enrolled machines)", async () => {
    if (!available) return;
    const { ctx, services } = await seedFleet();
    // The group id is not a first-class sandbox row → not found as a run_on target.
    const r = await runOnSandbox(services, ctx, ctx.sessionGroupId, {
      kind: "exec",
      cmd: "true",
    });
    expect(r.ok).toBe(false);
  }, 60_000);

  test("provision: selfhosted -> enrollment instructions; modal -> a named record", async () => {
    if (!available) return;
    const { ctx, services } = await seedFleet();

    const self = await provisionSandbox(services, ctx, { kind: "selfhosted" });
    expect(self.kind).toBe("selfhosted");
    if (self.kind === "selfhosted") {
      expect(self.installCommandUnix).toContain("install.sh");
      expect(self.verificationUri).toContain("/device");
    }

    const modal = await provisionSandbox(services, ctx, {
      kind: "modal",
      name: "extra-box",
    });
    expect(modal.kind).toBe("modal");
    if (modal.kind === "modal") {
      expect(modal.sandbox.kind).toBe("modal");
      expect(modal.sandbox.name).toBe("extra-box");
      expect(modal.sandbox.enrollmentId).toBeNull();
      // Honest copy (issue #341): the note must say plainly that the provisioned Modal
      // box is NOT yet attachable as a swap target — not imply an attach that is rejected.
      expect(modal.note).toMatch(/not yet attachable|not supported yet|rejected/i);
    }
  }, 60_000);

  // REGRESSION (issue #341 Shape 1 / invariant A): a swap to a first-class Modal
  // sibling was ADMITTED (resolveTarget had no modal branch) and the epoch bumped,
  // then every following op stranded because no turn context wires an establisher
  // for it. The establisher-capability gate must reject it BEFORE the CAS — typed
  // `unsupported_backend_context`, pointer + epoch untouched.
  test("swap to a NON-group Modal sibling is rejected BEFORE commit (Shape 1), pointer + epoch unchanged", async () => {
    if (!available) return;
    const { ctx, services } = await seedFleet();
    const before = (await readActiveSandbox(db, ctx.workspaceId, ctx.sessionId))!;
    expect(before.activeSandboxId).toBeNull();

    // Provision a first-class Modal sibling (a real sandboxes row, not the group box).
    const provisioned = await provisionSandbox(services, ctx, {
      kind: "modal",
      name: "sibling",
    });
    expect(provisioned.kind).toBe("modal");
    const siblingId = provisioned.kind === "modal" ? provisioned.sandbox.id : "";

    const r = await swapActiveSandbox(services, ctx, siblingId);
    expect(r.swapped).toBe(false);
    expect(r.code).toBe("unsupported_backend_context");
    expect(r.reason).toMatch(/Modal sandbox other than this session/i);

    // The CAS never ran: the pointer AND the epoch are exactly as before (no churn).
    const after = (await readActiveSandbox(db, ctx.workspaceId, ctx.sessionId))!;
    expect(after.activeSandboxId).toBeNull();
    expect(after.activeEpoch).toBe(before.activeEpoch);
    // The rejection echoes the unchanged pointer/epoch, not a moved one.
    expect(r.activeSandboxId).toBeNull();
    expect(r.activeEpoch).toBe(before.activeEpoch);
  }, 60_000);

  // The typed diagnostic also rides the liveness-gate rejection (offline_enrollment),
  // so a caller can branch on `code` rather than parse the human reason.
  test("swap to an offline machine carries the typed offline_enrollment code", async () => {
    if (!available) return;
    const { ctx, services, sandbox } = await seedFleet({ online: false });
    const r = await swapActiveSandbox(services, ctx, sandbox.id);
    expect(r.swapped).toBe(false);
    expect(r.code).toBe("offline_enrollment");
  }, 60_000);
});
