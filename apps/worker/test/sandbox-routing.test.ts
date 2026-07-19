// M7 — the WORKER turn-path routing wiring (wrapTurnBoxWithRouting), driven
// against the REAL packages/db on a THROWAWAY postgres + an in-memory
// MemoryEventBus agent responder (the selfhosted control plane stand-in). This is
// the worker companion to packages/runtime/test/routing-proxy.test.ts (the pure
// proxy) and apps/api/test/fleet-tools.test.ts (the fleet service): it proves the
// proxy the worker injects NON-OWNED into the turn re-reads the DB pointer per op
// and dispatches to the currently-active backend after a real setActiveSandbox.
//
// Proves:
//   - default pointer (null): the proxy routes to the established GROUP box.
//   - after setActiveSandbox (swap to the enrolled machine): the NEXT op routes to
//     the MACHINE (the in-memory agent answers it) — the SDK-binds-once contract.
//   - swap back to the group box routes there again (heterogeneous, single-active).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
  testSettings,
  MemoryEventBus,
} from "@opengeni/testing";
import { ControlRequest, ControlResponse } from "@opengeni/agent-proto";
import {
  createEnrollment,
  createSandbox,
  createSession,
  createDb,
  acquireLease,
  commitWarmingToWarm,
  getSandbox,
  readLease,
  readActiveSandbox,
  setActiveSandbox,
  type Database,
  type DbClient,
} from "@opengeni/db";
import {
  buildManifest,
  RoutingBackendRecoveryRequiredError,
  subjectFor,
  type EstablishedSandboxSession,
} from "@opengeni/runtime";
import { swapActiveSandbox, type FleetContext } from "@opengeni/core";
import {
  wrapLazyTurnBoxWithRouting,
  wrapTurnBoxWithRouting,
  routingEnabled,
} from "../src/sandbox-routing";
import { reconcileActiveSandboxPointer } from "../src/activities/agent-turn";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

const settings = testSettings({
  productAccessMode: "managed",
  sandboxSelfhostedEnabled: true,
  selfhostedRelayUrl: "wss://relay.example",
});

/** A MemoryEventBus whose responder echoes a marker hostname for exec — the
 *  enrolled machine. */
function busWithAgent(workspaceId: string, agentId: string, hostname: string): MemoryEventBus {
  const bus = new MemoryEventBus();
  const enc = new TextEncoder();
  bus.subscribeRequests(subjectFor(workspaceId, agentId), (payload) => {
    const req = ControlRequest.decode(payload);
    const op = req.op;
    let res: ControlResponse;
    if (op?.$case === "ping") {
      res = {
        requestId: req.requestId,
        result: { $case: "ping", ping: { nonce: op.ping.nonce, agentMonotonicMs: "0" } },
      };
    } else if (op?.$case === "exec") {
      res = {
        requestId: req.requestId,
        result: {
          $case: "exec",
          exec: {
            exitCode: 0,
            stdout: enc.encode(`${hostname}\n`),
            stderr: new Uint8Array(0),
            timedOut: false,
            durationMs: "1",
          },
        },
      };
    } else {
      res = {
        requestId: req.requestId,
        result: {
          $case: "exec",
          exec: {
            exitCode: 1,
            stdout: new Uint8Array(0),
            stderr: enc.encode("unsupported"),
            timedOut: false,
            durationMs: "0",
          },
        },
      };
    }
    return ControlResponse.encode(res).finish();
  });
  return bus;
}

/** A fake established GROUP box whose exec returns a fixed marker — the default
 *  routing target (active_sandbox_id == null). */
function fakeGroupBox(marker: string): EstablishedSandboxSession {
  const session = {
    state: { instanceId: "group-box" },
    async exec(_args: unknown) {
      return { stdout: marker, exitCode: 0 };
    },
  };
  return { client: {}, session, sessionState: {}, instanceId: "group-box", backendId: "modal" };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-sandbox-routing");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[worker-sandbox-routing] docker unavailable, skipping");
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

describe("M7 worker routing — wrapTurnBoxWithRouting + a real DB pointer + setActiveSandbox", () => {
  test("the proxy routes to the GROUP box by default, then to the MACHINE after a swap, then back", async () => {
    if (!available) return;
    expect(routingEnabled(settings)).toBe(true);

    const [a] = await admin<
      { id: string }[]
    >`insert into managed_accounts (name) values ('acct') returning id`;
    const [w] = await admin<
      { id: string }[]
    >`insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
    const accountId = a!.id;
    const workspaceId = w!.id;

    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      sandboxBackend: "modal",
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
    const sandbox = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "laptop",
      enrollmentId: enrollment.id,
    });

    // Seed the durable warm home so a same-target route epoch change exercises
    // the worker's lease-backed home resolver instead of the static fallback.
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      kind: "turn",
      holderId: "home-rebind-turn",
      subjectId: session.id,
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "group-box",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "group-box" } },
      },
      leaseTtlMs: 45_000,
    });
    expect(committed.committed).toBe(true);

    const bus = busWithAgent(workspaceId, enrollment.id, "the-laptop") as never;

    // Wrap the established group box in the routing proxy (what the turn does).
    const established = wrapTurnBoxWithRouting(
      { db, settings, bus },
      {
        workspaceId,
        sessionId: session.id,
        homeLease: {
          accountId,
          sandboxGroupId: session.sandboxGroupId,
          leaseEpoch: committed.lease!.leaseEpoch,
          instanceId: "group-box",
          backend: "modal",
        },
      },
      fakeGroupBox("group-box-marker"),
    );
    const proxy = established.session as { exec: (a: unknown) => Promise<{ stdout: string }> };

    // Default pointer (null) → the op lands on the GROUP box.
    expect((await proxy.exec({ cmd: "uname" })).stdout).toBe("group-box-marker");

    // SWAP mid-turn: repoint the session to the enrolled machine (epoch-bumped CAS).
    const swap = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: sandbox.id,
      expectedEpoch: 0,
    });
    expect(swap.swapped).toBe(true);

    // The NEXT op re-reads the pointer and lands on the MACHINE (the agent echoes
    // its hostname) — the SDK-binds-the-proxy-once contract: same object, new box.
    expect((await proxy.exec({ cmd: "echo $HOSTNAME" })).stdout.trim()).toBe("the-laptop");

    // Swap BACK to the group box (target null) → the op routes there again.
    const back = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: null,
      expectedEpoch: swap.pointer!.activeEpoch,
    });
    expect(back.swapped).toBe(true);
    expect((await proxy.exec({ cmd: "uname" })).stdout).toBe("group-box-marker");
  }, 60_000);

  test("operation-level 404/NOT_FOUND preserves the warm provider identity and epoch", async () => {
    if (!available) return;
    const [a] = await admin<
      { id: string }[]
    >`insert into managed_accounts (name) values ('acct-subresource-miss') returning id`;
    const [w] = await admin<
      { id: string }[]
    >`insert into workspaces (account_id, name) values (${a!.id}, 'ws-subresource-miss') returning id`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
    const accountId = a!.id;
    const workspaceId = w!.id;
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      sandboxBackend: "modal",
    });
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      kind: "turn",
      holderId: "subresource-miss-turn",
      subjectId: session.id,
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "box-still-live",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "box-still-live" } },
      },
      leaseTtlMs: 45_000,
    });
    expect(committed.committed).toBe(true);
    const warmEpoch = committed.lease!.leaseEpoch;
    const subresourceMissing = Object.assign(new Error("/workspace/missing.txt not found"), {
      code: "NOT_FOUND",
      status: 404,
    });
    const groupBox: EstablishedSandboxSession = {
      client: {},
      session: {
        state: { instanceId: "box-still-live" },
        async writeFile() {
          throw subresourceMissing;
        },
      },
      sessionState: {},
      instanceId: "box-still-live",
      backendId: "modal",
    };
    const established = wrapTurnBoxWithRouting(
      { db, settings, bus: new MemoryEventBus() as never },
      {
        workspaceId,
        sessionId: session.id,
        homeLease: {
          accountId,
          sandboxGroupId: session.sandboxGroupId,
          leaseEpoch: warmEpoch,
          instanceId: "box-still-live",
          backend: "modal",
        },
      },
      groupBox,
    );

    const error = await (established.session as { writeFile: (args: unknown) => Promise<unknown> })
      .writeFile({ path: "/workspace/missing.txt", content: "x" })
      .catch((caught) => caught);
    expect(error).toBe(subresourceMissing);
    const lease = await readLease(db, workspaceId, session.sandboxGroupId);
    expect(lease).toMatchObject({
      liveness: "warm",
      instanceId: "box-still-live",
      leaseEpoch: warmEpoch,
      recovery: { provider: { status: "exists", instanceId: "box-still-live" } },
    });
  }, 60_000);

  test("concurrent provider loss fences one lease epoch and never replays an ambiguous mutation", async () => {
    if (!available) return;
    const [a] = await admin<
      { id: string }[]
    >`insert into managed_accounts (name) values ('acct-provider-loss') returning id`;
    const [w] = await admin<
      { id: string }[]
    >`insert into workspaces (account_id, name) values (${a!.id}, 'ws-provider-loss') returning id`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
    const accountId = a!.id;
    const workspaceId = w!.id;
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      sandboxBackend: "modal",
    });

    const archive = Buffer.from("ope-60-concurrent-route-archive").toString("base64");
    const archiveBytes = Buffer.from(archive, "base64");
    const archiveSha256 = new Bun.CryptoHasher("sha256").update(archiveBytes).digest("hex");
    const descriptor = {
      version: 1 as const,
      revision: `wa1:1900000000000:${archiveSha256}`,
      archiveSha256,
      archiveBytes: archiveBytes.length,
      capturedAt: "2030-03-17T17:46:40.000Z",
      workspace: {
        algorithm: "sha256" as const,
        sha256: "b".repeat(64),
        entryCount: 2,
        fileCount: 1,
        totalFileBytes: 31,
      },
    };
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      kind: "turn",
      holderId: "provider-loss-turn",
      subjectId: session.id,
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(acquired.role).toBe("spawner");
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "box-before-concurrent-loss",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: {
          providerState: { sandboxId: "box-before-concurrent-loss" },
          workspaceArchive: archive,
          workspaceArchiveMeta: descriptor,
        },
      },
      leaseTtlMs: 45_000,
    });
    expect(committed.committed).toBe(true);
    expect(committed.lease?.leaseEpoch).toBe(acquired.lease.leaseEpoch + 1);
    const warmEpoch = committed.lease!.leaseEpoch;

    const operationCalls = Array.from({ length: 24 }, () => 0);
    let releaseProviderLoss!: () => void;
    const providerLossBarrier = new Promise<void>((resolve) => {
      releaseProviderLoss = resolve;
    });
    let providerCallsReached = 0;
    const missing = Object.assign(new Error("provider sandbox missing"), {
      code: "SANDBOX_NOT_FOUND",
      status: 404,
    });
    const groupBox: EstablishedSandboxSession = {
      client: {},
      session: {
        state: { instanceId: "box-before-concurrent-loss" },
        async writeFile(args: unknown) {
          const index = (args as { index: number }).index;
          operationCalls[index] += 1;
          providerCallsReached += 1;
          if (providerCallsReached === operationCalls.length) releaseProviderLoss();
          await providerLossBarrier;
          throw missing;
        },
      },
      sessionState: {},
      instanceId: "box-before-concurrent-loss",
      backendId: "modal",
    };
    const lossEvents: Array<{
      sandboxGroupId: string;
      instanceId: string;
      leaseEpoch: number;
    }> = [];
    const established = wrapTurnBoxWithRouting(
      {
        db,
        settings,
        bus: new MemoryEventBus() as never,
        onHomeSandboxLost: async (event) => {
          lossEvents.push(event);
        },
      },
      {
        workspaceId,
        sessionId: session.id,
        homeLease: {
          accountId,
          sandboxGroupId: session.sandboxGroupId,
          leaseEpoch: warmEpoch,
          instanceId: "box-before-concurrent-loss",
          backend: "modal",
        },
      },
      groupBox,
    );
    const proxy = established.session as { writeFile: (args: unknown) => Promise<unknown> };

    const results = await Promise.allSettled(
      operationCalls.map((_, index) => proxy.writeFile({ path: `/workspace/${index}`, index })),
    );
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    const errors = results.map((result) =>
      result.status === "rejected" ? result.reason : new Error("unexpected fulfilled mutation"),
    );
    expect(errors.every((error) => error instanceof RoutingBackendRecoveryRequiredError)).toBe(
      true,
    );
    const recoveries = errors.map(
      (error) => (error as RoutingBackendRecoveryRequiredError).recovery,
    );
    expect(recoveries.filter((status) => status === "pending")).toHaveLength(1);
    expect(recoveries.filter((status) => status === "superseded")).toHaveLength(23);
    expect(
      errors.every(
        (error) =>
          (error as RoutingBackendRecoveryRequiredError).leaseEpoch === warmEpoch + 1 &&
          (error as RoutingBackendRecoveryRequiredError).retryable,
      ),
    ).toBe(true);
    expect(operationCalls.every((calls) => calls === 1)).toBe(true);
    expect(lossEvents).toEqual([
      {
        sandboxGroupId: session.sandboxGroupId,
        instanceId: "box-before-concurrent-loss",
        leaseEpoch: warmEpoch + 1,
      },
    ]);

    const lease = await readLease(db, workspaceId, session.sandboxGroupId);
    expect(lease).toMatchObject({
      liveness: "cold",
      instanceId: null,
      leaseEpoch: warmEpoch + 1,
      recovery: {
        provider: {
          status: "missing",
          instanceId: "box-before-concurrent-loss",
          diagnostic: "provider_not_found_during_routed_operation",
        },
        archive: { status: "available", current: { revision: descriptor.revision } },
        restore: { status: "pending", selectedRevision: descriptor.revision },
        workspace: { status: "not_ready", verifiedRevision: null },
      },
    });
    expect(lease?.resumeState).not.toHaveProperty("sessionState.providerState");
    expect(lease?.resumeState).toHaveProperty("sessionState.workspaceArchive", archive);
  }, 60_000);

  test("routingEnabled is false when the selfhosted flag is off (the proxy is not wrapped)", () => {
    const off = testSettings({ sandboxSelfhostedEnabled: false });
    expect(routingEnabled(off)).toBe(false);
  });

  test("lazy wrapper seeds synthetic manifest and default-pointer ops single-flight through the provisioner", async () => {
    if (!available) return;
    const [a] = await admin<
      { id: string }[]
    >`insert into managed_accounts (name) values ('acct-lazy') returning id`;
    const [w] = await admin<
      { id: string }[]
    >`insert into workspaces (account_id, name) values (${a!.id}, 'ws-lazy') returning id`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
    const accountId = a!.id;
    const workspaceId = w!.id;
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      sandboxBackend: "modal",
    });
    const manifest = buildManifest(settings, [], { HOME: "/workspace", LAZY: "1" });
    let provisions = 0;
    const real = fakeGroupBox("lazy-real");
    const lazy = wrapLazyTurnBoxWithRouting(
      { db, settings, bus: new MemoryEventBus() as never },
      { workspaceId, sessionId: session.id, environment: { HOME: "/workspace", LAZY: "1" } },
      {
        client: { backendId: "modal" },
        backendId: "modal",
        agentDefaultManifest: manifest,
        provisioner: {
          get: async () => {
            provisions += 1;
            return { established: real };
          },
        },
      },
    );
    const proxy = lazy.session as {
      state: { manifest: unknown };
      exec: (a: unknown) => Promise<{ stdout: string }>;
    };

    expect(proxy.state.manifest).toBe(manifest);
    expect((await proxy.exec({ cmd: "echo hi" })).stdout).toBe("lazy-real");
    expect(provisions).toBe(1);
    expect((await proxy.exec({ cmd: "echo again" })).stdout).toBe("lazy-real");
    expect(provisions).toBe(1);
  });
});

describe("M7 worker routing — turn-start reconcile (issue #341 invariant B)", () => {
  async function seedAcctWs(tag: string): Promise<{ accountId: string; workspaceId: string }> {
    const [a] = await admin<
      { id: string }[]
    >`insert into managed_accounts (name) values (${`acct-${tag}`}) returning id`;
    const [w] = await admin<
      { id: string }[]
    >`insert into workspaces (account_id, name) values (${a!.id}, ${`ws-${tag}`}) returning id`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
    return { accountId: a!.id, workspaceId: w!.id };
  }

  test("a stranded Modal-sibling pointer resets to HOME (null) + emits session.route.reconciled (Shapes 1/2)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await seedAcctWs("recon");
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      sandboxBackend: "modal",
    });
    // A first-class Modal sibling row (no group/lease/box) — the categorical strand.
    const sibling = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "modal",
      name: "sibling",
    });
    // Persist a stranded pointer directly (a legacy pre-gate pointer / FK orphan):
    // the session points at the unestablishable sibling at epoch 1.
    const stranded = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: sibling.id,
      expectedEpoch: 0,
    });
    expect(stranded.swapped).toBe(true);
    const pointer = (await readActiveSandbox(db, workspaceId, session.id))!;

    const events: Array<{ type: string; payload: unknown }> = [];
    const result = await reconcileActiveSandboxPointer(
      db,
      { accountId, workspaceId, sessionId: session.id },
      pointer,
      (id) => getSandbox(db, workspaceId, id),
      async (evs) => {
        events.push(...evs);
      },
    );

    // Reset to HOME under the fence: pointer null, epoch bumped, record cleared.
    expect(result.pointer?.activeSandboxId ?? null).toBeNull();
    expect(result.pointer!.activeEpoch).toBe(pointer.activeEpoch + 1);
    expect(result.record).toBeNull();
    // The DB reflects the reset (not just the in-memory return).
    const persisted = (await readActiveSandbox(db, workspaceId, session.id))!;
    expect(persisted.activeSandboxId).toBeNull();
    expect(persisted.activeEpoch).toBe(pointer.activeEpoch + 1);
    // A VISIBLE typed event was emitted (never a silent downgrade), carrying the
    // reason + epochs but NO target id.
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("session.route.reconciled");
    expect(events[0]!.payload).toMatchObject({
      reason: "unsupported_backend_context",
      fromEpoch: pointer.activeEpoch,
      toEpoch: pointer.activeEpoch + 1,
    });
    expect(JSON.stringify(events[0]!.payload)).not.toContain(sibling.id);
  }, 60_000);

  test("reconcile is epoch-fenced: a concurrent higher-epoch swap is NOT clobbered", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await seedAcctWs("fence");
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      sandboxBackend: "modal",
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
    const machine = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "laptop",
      enrollmentId: enrollment.id,
    });
    const sibling = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "modal",
      name: "sibling",
    });

    // The turn LOADS a stranded modal-sibling pointer at epoch 1...
    await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: sibling.id,
      expectedEpoch: 0,
    });
    const stalePointer = (await readActiveSandbox(db, workspaceId, session.id))!;
    expect(stalePointer.activeEpoch).toBe(1);

    // ...but a CONCURRENT user swap moves the real pointer to the enrolled machine at a
    // HIGHER epoch (2) before the reconcile CAS runs.
    const concurrent = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: machine.id,
      expectedEpoch: stalePointer.activeEpoch,
    });
    expect(concurrent.swapped).toBe(true);
    expect(concurrent.pointer!.activeEpoch).toBe(2);

    const events: Array<{ type: string }> = [];
    const result = await reconcileActiveSandboxPointer(
      db,
      { accountId, workspaceId, sessionId: session.id },
      stalePointer,
      (id) => getSandbox(db, workspaceId, id),
      async (evs) => {
        events.push(...evs);
      },
    );

    // The stale reset LOST the fence: the user's machine swap survives untouched.
    expect(result.pointer?.activeSandboxId).toBe(machine.id);
    expect(result.pointer!.activeEpoch).toBe(2);
    expect(result.record?.id).toBe(machine.id);
    // No reconcile event (nothing was reset); the DB still points at the machine.
    expect(events).toHaveLength(0);
    const persisted = (await readActiveSandbox(db, workspaceId, session.id))!;
    expect(persisted.activeSandboxId).toBe(machine.id);
    expect(persisted.activeEpoch).toBe(2);
  }, 60_000);

  // FAIL-OPEN on a transient lookup failure (issue #341 review / Bugbot): a throwing
  // record lookup must NEVER be read as "row absent" and clear a (possibly healthy)
  // user-chosen pointer. The SAME stranded pointer that reconciles cleanly when the
  // lookup succeeds must be left UNTOUCHED (no CAS, no event) when the lookup throws.
  test("a transient record-lookup failure never mutates the pointer (fail-open to pre-reconcile behavior)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await seedAcctWs("transient");
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      sandboxBackend: "modal",
    });
    // A stranded Modal-sibling pointer that WOULD reconcile if the lookup succeeded.
    const sibling = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "modal",
      name: "sibling",
    });
    await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: sibling.id,
      expectedEpoch: 0,
    });
    const pointer = (await readActiveSandbox(db, workspaceId, session.id))!;
    expect(pointer.activeSandboxId).toBe(sibling.id);

    const events: Array<{ type: string }> = [];
    let lookups = 0;
    const result = await reconcileActiveSandboxPointer(
      db,
      { accountId, workspaceId, sessionId: session.id },
      pointer,
      // A transient DB blip: the lookup THROWS (recovered by the time the CAS would run).
      async () => {
        lookups += 1;
        throw new Error("transient db lookup failure");
      },
      async (evs) => {
        events.push(...evs);
      },
    );

    // Fail open: no reconciliation happened. The pointer is UNTOUCHED (still the sibling
    // at the same epoch), record null (→ machinePrimary:false, group box), no event.
    expect(lookups).toBe(1);
    expect(result.pointer?.activeSandboxId).toBe(sibling.id);
    expect(result.pointer!.activeEpoch).toBe(pointer.activeEpoch);
    expect(result.record).toBeNull();
    expect(events).toHaveLength(0);
    // Crucially the DB pointer/epoch never moved — no CAS ran on the transient failure.
    const persisted = (await readActiveSandbox(db, workspaceId, session.id))!;
    expect(persisted.activeSandboxId).toBe(sibling.id);
    expect(persisted.activeEpoch).toBe(pointer.activeEpoch);

    // Sanity: the SAME pointer DOES reconcile once the lookup succeeds (proves the throw
    // — not some other condition — is what suppressed the reset).
    const events2: Array<{ type: string }> = [];
    const recovered = await reconcileActiveSandboxPointer(
      db,
      { accountId, workspaceId, sessionId: session.id },
      pointer,
      (id) => getSandbox(db, workspaceId, id),
      async (evs) => {
        events2.push(...evs);
      },
    );
    expect(recovered.pointer?.activeSandboxId ?? null).toBeNull();
    expect(events2).toHaveLength(1);
    expect(events2[0]!.type).toBe("session.route.reconciled");
  }, 60_000);

  // BEHAVIORAL "pointer untouched" (issue #341 invariant A / Shape 1): a rejected
  // Modal-sibling swap must not move the pointer, proven by ROUTING — the next op
  // still lands on the pre-swap backend, not by DB inspection alone.
  test("a rejected sibling swap leaves the pointer untouched: the next op still routes to the pre-swap backend", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await seedAcctWs("reject-untouched");
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt-test",
      sandboxBackend: "modal",
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
    const machine = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "laptop",
      enrollmentId: enrollment.id,
    });
    const sibling = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "modal",
      name: "sibling",
    });
    const bus = busWithAgent(workspaceId, enrollment.id, "the-laptop") as never;

    // Pre-swap: pin the session to the machine (the pre-swap backend the ops route to).
    await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: machine.id,
      expectedEpoch: 0,
    });
    const before = (await readActiveSandbox(db, workspaceId, session.id))!;

    const established = wrapTurnBoxWithRouting(
      { db, settings, bus },
      { workspaceId, sessionId: session.id },
      fakeGroupBox("group-box-marker"),
    );
    const proxy = established.session as { exec: (a: unknown) => Promise<{ stdout: string }> };
    // The op currently routes to the machine (the pre-swap backend).
    expect((await proxy.exec({ cmd: "echo $HOSTNAME" })).stdout.trim()).toBe("the-laptop");

    // Attempt to swap onto the Modal sibling → REJECTED before the CAS.
    const ctx: FleetContext = {
      accountId,
      workspaceId,
      sessionId: session.id,
      sessionBackend: "modal",
      sessionGroupId: session.sandboxGroupId,
    };
    const rejected = await swapActiveSandbox({ db, settings, bus }, ctx, sibling.id);
    expect(rejected.swapped).toBe(false);
    expect(rejected.code).toBe("unsupported_backend_context");

    // The pointer never moved: the next op STILL routes to the pre-swap machine, and
    // the persisted pointer/epoch are unchanged.
    expect((await proxy.exec({ cmd: "echo $HOSTNAME" })).stdout.trim()).toBe("the-laptop");
    const after = (await readActiveSandbox(db, workspaceId, session.id))!;
    expect(after.activeSandboxId).toBe(machine.id);
    expect(after.activeEpoch).toBe(before.activeEpoch);
  }, 60_000);
});
